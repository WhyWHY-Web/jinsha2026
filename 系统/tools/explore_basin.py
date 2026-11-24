# -*- coding: utf-8 -*-
"""探索 HydroBASINS，定位金沙江流域（宜宾以上）边界"""
import ee, json

ee.Initialize(ee.ServiceAccountCredentials(
    json.load(open('tools/gee-key.json', encoding='utf-8'))['client_email'],
    'tools/gee-key.json'), project='jinsha-eco')

# 金沙江与岷江汇合点（宜宾）
YIBIN = ee.Geometry.Point(104.63, 28.72)

for lvl in [4, 5, 6, 7]:
    col = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_lev%02d' % lvl)
    f = col.filterBounds(YIBIN).first()
    if f is None:
        continue
    info = f.getInfo()
    props = info['properties']
    print('level %d: HYBAS_ID=%s PFAF_ID=%s UP_AREA=%.0f km2 SUB_AREA=%.0f km2'
          % (lvl, props.get('HYBAS_ID'), props.get('PFAF_ID'),
             props.get('UP_AREA', 0), props.get('SUB_AREA', 0)))
    print('   字段:', list(props.keys()))
