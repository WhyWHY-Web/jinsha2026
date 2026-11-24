# -*- coding: utf-8 -*-
"""RSEI 空间自相关：格网采样 + Queen 邻接权重 + 全局 Moran's I + 局部 LISA（同学丙 任务二）

流程：
  1) GEE 把 RSEI 降采样到 ~grid_deg 规则格网并采样（复用 rsei_gee.compute_rsei）
  2) 按格网构建 Queen 邻接权重（8 邻域）
  3) esda.Moran（全局）+ esda.Moran_Local（局部），permutations=999
  4) 显著性 0.05 下统计 HH/HL/LH/LL，并输出各类聚集中心（平均经纬度）
  5) 写云库 public.moran_lisa + 本地 data/rsei/lisa_<year>.csv（含逐点 LISA 类型，供绘图）

用法（需 GEE 网络，每期约 5-10 分钟）：
  python tools/moran_lisa.py --years 1990,2000,2010,2020
  python tools/moran_lisa.py --weights knn   # 备选：KNN(8) 权重

说明：Queen 邻接 = 规则格网上每个单元与其 8 邻域相邻；对不规则点样，可用 libpysal.weights.Voronoi。
"""
import argparse
import json
import os
import socket
import sys

import numpy as np
import ee

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg_util  # noqa: E402
import gee_common  # noqa: E402
import rsei_gee as R  # noqa: E402

OUT = os.path.join(ROOT, 'data', 'rsei')


def ensure_proxy():
    """GEE/GeoTIFF 下载需走本机 VPN 代理（默认 127.0.0.1:21081）。"""
    for k in ('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'):
        if os.environ.get(k):
            return
    s = socket.socket()
    s.settimeout(0.3)
    port = 21081 if s.connect_ex(('127.0.0.1', 21081)) == 0 else None
    s.close()
    if port:
        px = 'http://127.0.0.1:%d' % port
        os.environ['HTTP_PROXY'] = os.environ['HTTPS_PROXY'] = px
        print('代理: %s' % px)


def rsei_from_saved_loadings(year):
    """复用 rsei_<year>.json 里已算好的 PC1 载荷重建 RSEI 栅格。

    与 compute_rsei 唯一区别：跳过 pca_loadings() 的 4000 点 sample().getInfo()
    （最耗 EE 配额的一步），载荷直接取已保存结果，其余完全一致。
    """
    meta = json.load(open(os.path.join(OUT, 'rsei_%d.json' % year), encoding='utf-8'))
    ld = meta['pc1_loadings']
    wl, ww, ws, wt = ld['ndvi'], ld['wet'], ld['ndsi'], ld['lst']
    img, sensor, _n = R.composite(year)
    cfg = R.SENSORS[sensor]
    stack = R.four_components(img, cfg)
    norm = ee.Image.cat([R.normalize(stack, b) for b in ['ndvi', 'wet', 'ndsi', 'lst']])
    pc1 = (norm.select('ndvi').multiply(wl).add(norm.select('wet').multiply(ww))
           .add(norm.select('ndsi').multiply(ws)).add(norm.select('lst').multiply(wt)))
    rsei0 = (pc1.multiply(-1) if wl < 0 else pc1).rename('rsei0')
    pr = rsei0.reduceRegion(reducer=ee.Reducer.percentile([2, 98]), geometry=R.aoi,
                            scale=250, maxPixels=1e10, bestEffort=True, tileScale=4)
    lo = ee.Number(pr.get('rsei0_p2')); hi = ee.Number(pr.get('rsei0_p98'))
    return rsei0.subtract(lo).divide(hi.subtract(lo)).clamp(0, 1).rename('rsei')


def sample_grid(aoi, year, grid_deg=0.1):
    """导出 RSEI 1km GeoTIFF 到本地，再用 rasterio 采样，返回 [(lon, lat, rsei)]。

    绕开 GEE 的 reduceRegions/reproject 同步超时：先把 RSEI 物化成 0.01°(~1.1km)
    GeoTIFF，本地点读采样，稳定可靠。
    """
    import rasterio
    import urllib.request
    rsei = rsei_from_saved_loadings(year)
    url = rsei.getDownloadURL({
        'region': aoi, 'scale': 1000, 'crs': 'EPSG:4326',
        'format': 'GEO_TIFF', 'maxPixels': 1e9,
    })
    tif = os.path.join(OUT, 'rsei_%d_1km.tif' % year)
    urllib.request.urlretrieve(url, tif)
    ring = aoi.bounds().getInfo()['coordinates'][0]
    lon0, lat0 = ring[0][0], ring[0][1]
    lon1, lat1 = ring[2][0], ring[2][1]
    rows = []
    with rasterio.open(tif) as src:
        nodata = src.nodata
        lon = lon0
        while lon <= lon1:
            lat = lat0
            while lat <= lat1:
                r, c = (int(round(v)) for v in src.index(lon, lat))
                if 0 <= r < src.height and 0 <= c < src.width:
                    v = src.read(1, window=((r, r + 1), (c, c + 1)))[0, 0]
                    if v is not None and not np.isnan(float(v)) and (nodata is None or float(v) != nodata):
                        rows.append((round(lon, 6), round(lat, 6), round(float(v), 6)))
                lat += grid_deg
            lon += grid_deg
    return rows


def queen_weights(rows, grid_deg):
    """在规则格网上构建 Queen 邻接（8 邻域）权重矩阵。"""
    from libpysal.weights import W
    coord2id = {}
    for i, (lon, lat, _v) in enumerate(rows):
        k = (round(lon / grid_deg), round(lat / grid_deg))
        coord2id.setdefault(k, i)  # 同格点只保留第一个
    offs = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    neighbors = {}
    for (gi, gj), i in coord2id.items():
        nb = [coord2id[(gi + di, gj + dj)] for di, dj in offs
              if (gi + di, gj + dj) in coord2id]
        neighbors[i] = nb
    w = W(neighbors, silence_warnings=True)
    w.transform = 'r'  # 行标准化
    return w


def analyze(rows, weight_type='queen', grid_deg=0.09):
    import esda
    if len(rows) < 50:
        return None
    coords = np.array([[lon, lat] for lon, lat, _v in rows])
    values = np.array([v for _lon, _lat, v in rows])
    if weight_type == 'queen':
        w = queen_weights(rows, grid_deg)
    else:
        from libpysal.weights import KNN
        w = KNN(coords, k=8)
        w.transform = 'r'
    moran = esda.Moran(values, w, permutations=999)
    lisa = esda.Moran_Local(values, w, permutations=999)
    sig = lisa.p_sim < 0.05
    q = lisa.q
    hh, ll, hl, lh = (sig & (q == 1)), (sig & (q == 3)), (sig & (q == 2)), (sig & (q == 4))

    def center(mask):
        return (round(float(coords[mask, 0].mean()), 3), round(float(coords[mask, 1].mean()), 3)) \
            if mask.sum() else None

    return {
        'n_units': len(rows),
        'global_moran': round(float(moran.I), 5),
        'z_score': round(float(moran.z_sim), 4),
        'p_value': round(float(moran.p_sim), 6),
        'hh': int(hh.sum()), 'hl': int(hl.sum()), 'lh': int(lh.sum()), 'll': int(ll.sum()),
        'hh_center': center(hh), 'll_center': center(ll),
        'labels': np.where(hh, 'HH', np.where(ll, 'LL', np.where(hl, 'HL', np.where(lh, 'LH', 'NS')))).tolist(),
        'coords': coords.tolist(),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=None)
    ap.add_argument('--years', type=str, default=None)
    ap.add_argument('--grid-deg', type=float, default=0.1)
    ap.add_argument('--weights', default='queen', choices=['queen', 'knn'])
    args = ap.parse_args()

    ensure_proxy()
    gee_common.init()
    _, aoi = gee_common.load_aoi()
    R.aoi = aoi

    years = ([int(y) for y in args.years.split(',')] if args.years
             else [args.year] if args.year
             else [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025])

    db_rows = []
    for y in years:
        print('[%d] 格网采样...' % y)
        rows = sample_grid(aoi, y, args.grid_deg)
        res = analyze(rows, args.weights, args.grid_deg)
        if not res:
            print('      样本不足，跳过')
            continue
        print('      Moran I=%.4f (p=%.4f)  HH=%d LL=%d HL=%d LH=%d' %
              (res['global_moran'], res['p_value'], res['hh'], res['ll'], res['hl'], res['lh']))
        if res['hh_center']:
            print('      HH 聚集中心 %s；LL 聚集中心 %s' % (res['hh_center'], res['ll_center']))
        db_rows.append((y, res['global_moran'], res['z_score'], res['p_value'],
                        res['hh'], res['hl'], res['lh'], res['ll'], res['n_units'],
                        args.weights, 'RSEI (徐涵秋) + Queen邻接', pg_util.now()))
        # 逐点 LISA 标签，供画聚类图
        csv_path = os.path.join(OUT, 'lisa_%d.csv' % y)
        with open(csv_path, 'w', encoding='utf-8') as fp:
            fp.write('lon,lat,rsei,lisa\n')
            for (lon, lat, v), lab in zip(rows, res['labels']):
                fp.write('%s,%s,%s,%s\n' % (lon, lat, v, lab))

    if db_rows:
        pg_util.upsert('moran_lisa',
                       ['year', 'global_moran', 'z_score', 'p_value', 'hh', 'hl', 'lh', 'll',
                        'n_units', 'weight_type', 'source', 'updated_at'],
                       db_rows, conflict_cols=['year'])
    keys = ['year', 'global_moran', 'z_score', 'p_value', 'hh', 'hl', 'lh', 'll',
            'n_units', 'weight_type', 'source', 'updated_at']
    path = os.path.join(OUT, 'moran_lisa.json')
    # 累积合并：读取已有结果，用本次结果按年份覆盖，避免分批跑时丢失之前的期
    merged = {}
    if os.path.isfile(path):
        try:
            for r in json.load(open(path, encoding='utf-8')):
                merged[r['year']] = r
        except Exception:
            pass
    for r in db_rows:
        rec = dict(zip(keys, r))
        merged[rec['year']] = rec
    out_rows = [merged[k] for k in sorted(merged)]
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(out_rows, fp, ensure_ascii=False, indent=2)
    print('Moran/LISA 已写入 moran_lisa 表（本次 %d 期，累计 %d 期）' % (len(db_rows), len(out_rows)))


if __name__ == '__main__':
    main()
