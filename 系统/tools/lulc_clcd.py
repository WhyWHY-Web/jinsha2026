# -*- coding: utf-8 -*-
"""金沙江流域逐年土地利用面积统计（同学丙 任务一-1）

数据源（主）：CLCD 30m 中国逐年土地覆盖（武汉大学 杨杰/黄昕，1985+1990-2025，Zenodo）
    下载：https://zenodo.org/records/15853565 （Cloud Optimized GeoTIFF，可按窗口远程读取）
    分类：1耕地 2森林 3灌木 4草地 5水体 6冰雪 7裸地 8建设用地 9湿地
    总体精度 79.31%（Yang & Huang 2021, ESSD 13:3907-3925）
数据源（兜底）：MODIS MCD12Q1 500m（2001-2023，GEE 原生，无需下载）

输出：写云库 public.lulc + 本地 data/lulc/lulc_<year>.csv

用法：
  python tools/lulc_clcd.py --source clcd --years 1990,2000,2010,2020      # CLCD 30m（默认）
  python tools/lulc_clcd.py --source gee  --years 2001,2005,2010,2015,2020 # MODIS 兜底
  python tools/lulc_clcd.py --source clcd --download --years 2020          # 远程读失败时先下到本地
"""
import argparse
import json
import os
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import pg_util  # noqa: E402

BASIN = os.path.join(ROOT, 'data', 'basin', 'jinsha_basin.geojson')
OUT = os.path.join(ROOT, 'data', 'lulc')
CLCD_DIR = os.path.join(ROOT, 'data', 'clcd')
os.makedirs(OUT, exist_ok=True)

CLCD_BASE = 'https://zenodo.org/records/15853565'
CLCD_CLASS = {1: '耕地', 2: '森林', 3: '灌木', 4: '草地', 5: '水体',
              6: '冰雪', 7: '裸地', 8: '建设用地', 9: '湿地'}
CLCD_PIX_KM2 = 30 * 30 / 1e6  # 0.0009 km²/像元

# IGBP(MCD12Q1 LC_Type1) -> CLCD 9 类
IGBP2CLCD = {0: 5, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 4, 9: 4,
             10: 4, 11: 9, 12: 1, 13: 8, 14: 1, 15: 6, 16: 7}


def load_basin_shp():
    from shapely.geometry import shape
    from shapely.ops import unary_union
    gj = json.load(open(BASIN, encoding='utf-8'))
    return unary_union([shape(f['geometry']) for f in gj['features']])


# ---------------- CLCD 30m（窗口读取，避免下载全量） ----------------
def clcd_url(year, local=False):
    if local:
        return os.path.join(CLCD_DIR, 'CLCD_v01_%d_albert.tif' % year)
    return '/vsicurl/%s/files/CLCD_v01_%d_albert.tif?download=1' % (CLCD_BASE, year)


def zonal_clcd(year, local=False):
    """返回 (area_km2: dict[类名], total_km2)。"""
    import rasterio
    from rasterio.features import rasterize
    from rasterio.warp import transform_bounds
    from rasterio.windows import Window
    from shapely.ops import transform as shapely_transform
    from pyproj import Transformer

    poly = load_basin_shp()
    with rasterio.open(clcd_url(year, local)) as src:
        left, bottom, right, top = transform_bounds('EPSG:4326', src.crs, *poly.bounds)
        win = src.window(left, bottom, right, top).intersection(Window(0, 0, src.width, src.height))
        data = src.read(1, window=win)
        nodata = src.nodata
        wt = src.window_transform(win)
        tr = Transformer.from_crs('EPSG:4326', src.crs, always_xy=True)
        poly_t = shapely_transform(tr.transform, poly)
        mask = rasterize([(poly_t, 1)], out_shape=data.shape, transform=wt, fill=0, dtype='uint8')
    valid = mask == 1
    if nodata is not None:
        valid = valid & (data != nodata)
    area = {name: float(np.sum((data == c) & valid)) * CLCD_PIX_KM2
            for c, name in CLCD_CLASS.items()}
    return area, float(np.sum(valid)) * CLCD_PIX_KM2


def download_clcd(year):
    """网络窗口读取失败时，把整年 tif 下到本地（约 800MB/年，慎用）。"""
    import urllib.request
    os.makedirs(CLCD_DIR, exist_ok=True)
    url = '%s/files/CLCD_v01_%d_albert.tif?download=1' % (CLCD_BASE, year)
    dst = clcd_url(year, local=True)
    print('[..] 下载 %d 年 CLCD -> %s（约 800MB）' % (year, dst))
    urllib.request.urlretrieve(url, dst)
    print('      下载完成')


# ---------------- MODIS MCD12Q1 500m（GEE 兜底） ----------------
def zonal_gee(year, aoi):
    """返回 (area_km2: dict[类名], total_km2)。单次 grouped reduceRegion。"""
    import ee
    lc = (ee.ImageCollection('MODIS/061/MCD12Q1')
          .filterDate('%d-01-01' % year, '%d-12-31' % year)
          .select('LC_Type1').first().clip(aoi))
    remap = lc.remap(list(range(17)), [IGBP2CLCD.get(i, 0) for i in range(17)], 0).rename('cls')
    pix_area_km2 = ee.Image.pixelArea().divide(1e6)  # km²/像元
    grp = ee.Image.cat([pix_area_km2, remap]).reduceRegion(
        reducer=ee.Reducer.sum().group(groupField=1, groupName='cls'),
        geometry=aoi, scale=500, maxPixels=1e9, bestEffort=True, tileScale=8)
    info = ee.List(grp.get('groups')).getInfo()
    area = {}
    for g in info:
        cls = int(g['cls'])
        if cls in CLCD_CLASS:
            area[CLCD_CLASS[cls]] = float(g['sum'])
    return area, sum(area.values())


def emit(year, area, total, source):
    rows = []
    for code, name in CLCD_CLASS.items():
        a = area.get(name, 0.0)
        rows.append((year, name, code, round(a, 3),
                     round(a / total * 100, 4) if total else 0.0,
                     source, pg_util.now()))
    pg_util.upsert('lulc', ['year', 'class', 'class_code', 'area_km2', 'pct', 'source', 'updated_at'],
                   rows, conflict_cols=['year', 'class'])
    csv_path = os.path.join(OUT, 'lulc_%d.csv' % year)
    with open(csv_path, 'w', encoding='utf-8-sig') as fp:
        fp.write('year,class,class_code,area_km2,pct\n')
        for r in rows:
            fp.write('%d,%s,%d,%s,%s\n' % (r[0], r[1], r[2], r[3], r[4]))
    crop = area.get('耕地', 0); forest = area.get('森林', 0); grass = area.get('草地', 0)
    built = area.get('建设用地', 0)
    print('[%d] 耕地%.1f%% 林草%.1f%% 建设用地%.2f%% -> lulc 表 + %s'
          % (year, crop / total * 100, (forest + grass) / total * 100,
             built / total * 100, os.path.basename(csv_path)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', default='clcd', choices=['clcd', 'gee'])
    ap.add_argument('--years', default=None, help='逗号分隔，如 1990,2000,2010,2020')
    ap.add_argument('--download', action='store_true', help='CLCD 整年下载到本地再读')
    args = ap.parse_args()

    if args.source == 'clcd':
        years = [int(y) for y in args.years.split(',')] if args.years else list(range(1990, 2024))
        src_label = 'CLCD 30m (Yang&Huang, Zenodo 15853565)'
        for y in years:
            try:
                area, total = zonal_clcd(y, local=args.download)
            except Exception as e:
                if args.download:
                    raise
                print('[%d] 远程读取失败（%s），尝试下载...' % (y, str(e)[:80]))
                download_clcd(y)
                area, total = zonal_clcd(y, local=True)
            emit(y, area, total, src_label)
    else:
        import gee_common
        gee_common.init()
        _, aoi = gee_common.load_aoi()
        years = [int(y) for y in args.years.split(',')] if args.years else list(range(2001, 2024))
        src_label = 'MODIS MCD12Q1 500m (IGBP->CLCD)'
        for y in years:
            area, total = zonal_gee(y, aoi)
            emit(y, area, total, src_label)


if __name__ == '__main__':
    main()
