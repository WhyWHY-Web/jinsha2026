# -*- coding: utf-8 -*-
"""金沙江流域逐年总人口（同学丙 任务一-3）

数据源：
  GHS-POP（JRC/GHSL/P2023A/GHS_POP，100m，1975-2030 每5年，波段 population_count）
  WorldPop R2025A（WorldPop/GP/100m/R2025A/v1/pop，100m，中国 CHN_2015..CHN_2030 逐年，波段 population）
说明：GHS-POP 覆盖长历史；WorldPop 提供近 15 年逐年高分辨率。二者按 source 区分写入同一表。

输出：写云库 public.population + 本地 data/population/population.csv

用法：
  python tools/population_gee.py                 # GHS-POP 1990-2030 每5年 + WorldPop 中国 2015-2030
  python tools/population_gee.py --ghs-only      # 只要 GHS-POP
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import pg_util  # noqa: E402
import gee_common  # noqa: E402

OUT = os.path.join(ROOT, 'data', 'population')
os.makedirs(OUT, exist_ok=True)


def sum_pop(coll_id, band, aoi, scale, years=None, prefix=None):
    import ee
    col = ee.ImageCollection(coll_id)
    out = []
    for idx in col.aggregate_array('system:index').getInfo():
        if prefix:
            if not idx.startswith(prefix):
                continue
            year = int(idx.split('_')[1])
        else:
            year = int(idx[:4])
        if years and year not in years:
            continue
        img = ee.Image(coll_id + '/' + idx).select(band)
        # 100m 对 47.6 万 km² 有 ~4.7e7 像元，直接 sum 会超时；
        # 先降采样到 ~1km（sum 保持总量守恒）再求和。
        resampled = (img.reduceResolution(reducer=ee.Reducer.sum(), bestEffort=True, maxPixels=1024)
                     .reproject(crs='EPSG:3857', scale=1000))
        s = resampled.reduceRegion(reducer=ee.Reducer.sum(), geometry=aoi, scale=1000,
                                   maxPixels=1e8, bestEffort=True, tileScale=4)
        v = s.getInfo().get(band)
        out.append((year, v, coll_id))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ghs-only', action='store_true')
    args = ap.parse_args()

    gee_common.init()
    _, aoi = gee_common.load_aoi()
    rows = []

    # GHS-POP 5 年档 1990-2030
    for year, v, _ in sum_pop('JRC/GHSL/P2023A/GHS_POP', 'population_count', aoi, 100,
                              years=list(range(1990, 2031, 5))):
        if v is None:
            continue
        rows.append((year, round(float(v)), 'GHS-POP P2023A (100m, 5-year)', pg_util.now()))
        print('[%d] GHS-POP 总人口 = %.0f' % (year, v))

    if not args.ghs_only:
        # WorldPop 中国逐年 2015-2030（system:index 形如 CHN_2015）
        for year, v, _ in sum_pop('WorldPop/GP/100m/R2025A/v1/pop', 'population', aoi, 100,
                                  years=list(range(2015, 2031)), prefix='CHN_'):
            if v is None:
                continue
            rows.append((year, round(float(v)), 'WorldPop R2025A (100m, 中国逐年)', pg_util.now()))
            print('[%d] WorldPop 总人口 = %.0f' % (year, v))

    rows.sort()
    pg_util.upsert('population', ['year', 'total_pop', 'source', 'updated_at'],
                   rows, conflict_cols=['year', 'source'])
    csv_path = os.path.join(OUT, 'population.csv')
    import csv as _csv
    with open(csv_path, 'w', encoding='utf-8-sig', newline='') as fp:
        w = _csv.writer(fp)
        w.writerow(['year', 'total_pop', 'source'])
        for r in rows:
            w.writerow([r[0], r[1], r[2]])
    print('共 %d 条写入 population 表 + %s' % (len(rows), csv_path))


if __name__ == '__main__':
    main()
