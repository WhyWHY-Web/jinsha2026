# -*- coding: utf-8 -*-
"""金沙江流域逐年夜间灯光强度（同学丙 任务一-2）

数据源：NPP-VIIRS 年度灯光
    NOAA/VIIRS/DNB/ANNUAL_V21  2013-2021（波段 average_masked，单位 nW/cm2/sr）
    NOAA/VIIRS/DNB/ANNUAL_V22  2022-2025（波段 average_masked）
    （背景/杂散光已剔除的年度平均辐亮度，~463m 分辨率）
可选补全长序列：NOAA/DMSP-OLS/NIGHTTIME_LIGHTS stable_lights 1992-2013（~1km，饱和，与 VIIRS 不可直接比较）

输出：写云库 public.nightlight + 本地 data/nightlight/nightlight.csv

用法：
  python tools/nightlight_gee.py                # VIIRS 2013-2025
  python tools/nightlight_gee.py --include-dmsp # 追加 DMSP 1992-2013
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import pg_util  # noqa: E402
import gee_common  # noqa: E402

OUT = os.path.join(ROOT, 'data', 'nightlight')
os.makedirs(OUT, exist_ok=True)


def mean_radiance(coll_id, band, aoi, scale):
    import ee
    col = ee.ImageCollection(coll_id)
    out = []
    for idx in col.aggregate_array('system:index').getInfo():
        img = ee.Image(coll_id + '/' + idx).select(band)
        # 降采样到 ~1km 再取均值，避免 463m 大范围 reduceRegion 超时
        resampled = (img.reduceResolution(reducer=ee.Reducer.mean(), bestEffort=True, maxPixels=1024)
                     .reproject(crs='EPSG:3857', scale=1000))
        m = resampled.reduceRegion(reducer=ee.Reducer.mean(), geometry=aoi, scale=1000,
                                   maxPixels=1e8, bestEffort=True, tileScale=4)
        v = m.getInfo().get(band)
        out.append((int(idx[:4]), v, coll_id))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--include-dmsp', action='store_true')
    args = ap.parse_args()

    gee_common.init()
    _, aoi = gee_common.load_aoi()

    rows = []
    # VIIRS V21 + V22，波段 average_masked（背景已掩膜）
    for coll_id, scale in [('NOAA/VIIRS/DNB/ANNUAL_V21', 463), ('NOAA/VIIRS/DNB/ANNUAL_V22', 463)]:
        for year, v, _ in mean_radiance(coll_id, 'average_masked', aoi, scale):
            if v is None:
                continue
            rows.append((year, round(float(v), 6),
                         'NPP-VIIRS DNB annual (%s, average_masked, nW/cm2/sr)' % coll_id,
                         pg_util.now()))
            print('[%d] VIIRS 年均灯光 = %.4f' % (year, v))

    if args.include_dmsp:
        for year, v, _ in mean_radiance('NOAA/DMSP-OLS/NIGHTTIME_LIGHTS', 'stable_lights', aoi, 1000):
            if v is None:
                continue
            rows.append((year, round(float(v), 6),
                         'DMSP-OLS stable_lights (1km, 饱和, 与VIIRS不可直接比较)', pg_util.now()))
            print('[%d] DMSP stable_lights = %.2f' % (year, v))

    rows.sort()
    pg_util.upsert('nightlight', ['year', 'mean_radiance', 'source', 'updated_at'],
                   rows, conflict_cols=['year'])
    csv_path = os.path.join(OUT, 'nightlight.csv')
    import csv as _csv
    with open(csv_path, 'w', encoding='utf-8-sig', newline='') as fp:
        w = _csv.writer(fp)
        w.writerow(['year', 'mean_radiance', 'source'])
        for r in rows:
            w.writerow([r[0], r[1], r[2]])
    print('共 %d 条写入 nightlight 表 + %s' % (len(rows), csv_path))


if __name__ == '__main__':
    main()
