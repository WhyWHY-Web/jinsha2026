# -*- coding: utf-8 -*-
"""
RSEI 空间自相关：格网采样 + Moran's I（全局）+ LISA（局部）
流程：GEE 格网采样 RSEI -> CSV -> esda 算 Moran's I 与 LISA 聚类
用法（需先确保 GEE 网络可用）：
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 或走 VPN 代理
  python tools/rsei_moran.py --year 2020          # 单期
  python tools/rsei_moran.py --years 1990,2020    # 多期
"""
import ee, json, os, sys, argparse
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rsei_gee as R

OUT = os.path.join(ROOT, 'data', 'rsei')

def init():
    ee.Initialize(ee.ServiceAccountCredentials(
        json.load(open(os.path.join(ROOT, 'tools', 'gee-key.json'), encoding='utf-8'))['client_email'],
        os.path.join(ROOT, 'tools', 'gee-key.json')), project='jinsha-eco')
    fc, aoi = R.load_aoi()
    R.aoi = aoi
    return aoi

def sample_grid(aoi, year, grid_deg=0.09):
    """格网采样：降采样到 ~10km 格网，取格网中心点 RSEI 值"""
    rsei, rsei_class, sensor, n, load, norm = R.compute_rsei(year)
    rsei_grid = (rsei.reduceResolution(reducer=ee.Reducer.mean(), bestEffort=True, maxPixels=1024)
                    .reproject(crs='EPSG:4326', scale=grid_deg))
    pts = rsei_grid.sample(region=aoi, scale=grid_deg, numPixels=5000, seed=42,
                           geometries=True, tileScale=4)
    feats = pts.getInfo()['features']
    rows = []
    for f in feats:
        g = f['geometry']['coordinates']
        v = f['properties'].get('rsei')
        if v is not None and not np.isnan(v):
            rows.append((round(g[0], 6), round(g[1], 6), round(float(v), 6)))
    return rows

def analyze(rows):
    """esda 算全局 Moran's I 与局部 LISA"""
    import libpysal
    from libpysal.weights import KNN
    import esda
    coords = np.array([[lon, lat] for lon, lat, v in rows])
    values = np.array([v for lon, lat, v in rows])
    if len(rows) < 50:
        return None
    w = KNN(coords, k=8)
    w.transform = 'r'
    moran = esda.Moran(values, w, permutations=999)
    lisa = esda.Moran_Local(values, w, permutations=999)
    # LISA 聚类类型（显著性 0.05）
    sig = lisa.p_sim < 0.05
    q = lisa.q
    z = (values - values.mean()) / values.std()
    hh = int(np.sum(sig & (q == 1)))
    ll = int(np.sum(sig & (q == 3)))
    hl = int(np.sum(sig & (q == 2)))
    lh = int(np.sum(sig & (q == 4)))
    return {
        'n': len(rows),
        'moran_I': round(float(moran.I), 4),
        'moran_p': round(float(moran.p_sim), 4),
        'moran_z': round(float(moran.z_sim), 4),
        'sig_clusters': int(np.sum(sig)),
        'HH': hh, 'LL': ll, 'HL': hl, 'LH': lh,
    }

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=None)
    ap.add_argument('--years', type=str, default=None)
    ap.add_argument('--grid-deg', type=float, default=0.09)
    args = ap.parse_args()
    aoi = init()
    if args.years:
        years = [int(y) for y in args.years.split(',') if y.strip()]
    elif args.year:
        years = [args.year]
    else:
        years = [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]

    allres = {}
    for y in years:
        print('[%d] 格网采样...' % y)
        rows = sample_grid(aoi, y, args.grid_deg)
        csv_path = os.path.join(OUT, 'grid_%d.csv' % y)
        with open(csv_path, 'w', encoding='utf-8') as fp:
            fp.write('lon,lat,rsei\n')
            for r in rows:
                fp.write('%s,%s,%s\n' % r)
        print('      采样点 %d 个，已存 %s' % (len(rows), os.path.basename(csv_path)))
        res = analyze(rows)
        if res:
            res['year'] = y
            allres[y] = res
            print('      Moran I=%.4f (p=%.4f)  HH=%d LL=%d HL=%d LH=%d' %
                  (res['moran_I'], res['moran_p'], res['HH'], res['LL'], res['HL'], res['LH']))
        else:
            allres[y] = {'year': y, 'n': len(rows), 'error': '样本不足'}

    path = os.path.join(OUT, 'moran_lisa.json')
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(allres, fp, ensure_ascii=False, indent=2)
    print('Moran/LISA 结果已保存:', path)

if __name__ == '__main__':
    main()
