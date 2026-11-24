# -*- coding: utf-8 -*-
"""提取金沙江流域边界（宜宾以上长江流域）并导出 GeoJSON
方法：HydroBASINS level 6，定位宜宾出口 basin，沿 NEXT_DOWN 向上追溯所有上游子流域，
合并为金沙江流域多边形。验证面积约 47 万 km²。
"""
import ee, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'basin')

ee.Initialize(ee.ServiceAccountCredentials(
    json.load(open(os.path.join(ROOT, 'tools', 'gee-key.json'), encoding='utf-8'))['client_email'],
    os.path.join(ROOT, 'tools', 'gee-key.json')), project='jinsha-eco')

YIBIN = ee.Geometry.Point(104.63, 28.77)   # 金沙江与岷江汇合点（合江门，金沙江侧）
LEVEL = 6

hybas = ee.FeatureCollection('WWF/HydroSHEDS/v1/Basins/hybas_%d' % LEVEL)

# 1) 定位出口 basin
outlet = hybas.filterBounds(YIBIN).first()
oi = outlet.getInfo()
oid = oi['properties']['HYBAS_ID']
print('出口 basin HYBAS_ID=%s UP_AREA=%.0f km2 SUB_AREA=%.0f km2 MAIN_BAS=%s'
      % (oid, oi['properties'].get('UP_AREA', 0), oi['properties'].get('SUB_AREA', 0),
         oi['properties'].get('MAIN_BAS')))

# 2) 拉取金沙江流域大范围 bbox 内的 level 6 子流域（通天河源头 ~90.5°E）
bbox = ee.Geometry.Rectangle([90.0, 24.0, 106.0, 35.0])
sub = hybas.filterBounds(bbox)
feats = sub.getInfo()['features']
print('bbox 内 level %d 子流域数: %d' % (LEVEL, len(feats)))

# 3) 本地图遍历：从出口 basin 沿 NEXT_DOWN 追溯所有上游
by_id = {}
for f in feats:
    p = f['properties']
    by_id[p['HYBAS_ID']] = f

upstream = {oid}
changed = True
while changed:
    changed = False
    for hid, f in by_id.items():
        if hid in upstream:
            continue
        nd = f['properties'].get('NEXT_DOWN')
        if nd in upstream:
            upstream.add(hid)
            changed = True
print('上游子流域数（含出口）: %d' % len(upstream))

# 4) 合并几何 + 面积
sel_feats = [by_id[h] for h in upstream]
fc = ee.FeatureCollection([ee.Feature(ee.Geometry(f['geometry'])) for f in sel_feats])
geom = fc.geometry()
area = geom.area(1).getInfo() / 1e6   # km²
print('金沙江流域合并面积: %.0f km²' % area)

# 5) 导出 GeoJSON
os.makedirs(OUT, exist_ok=True)
geojson = {
    'type': 'FeatureCollection',
    'name': '金沙江流域（宜宾以上）',
    'properties': {'level': LEVEL, 'outlet_hybas_id': oid, 'area_km2': round(area, 1)},
    'features': [{'type': 'Feature', 'geometry': f['geometry'],
                  'properties': {'HYBAS_ID': f['properties']['HYBAS_ID'],
                                 'SUB_AREA': f['properties'].get('SUB_AREA')}}
                 for f in sel_feats],
}
path = os.path.join(OUT, 'jinsha_basin.geojson')
with open(path, 'w', encoding='utf-8') as fp:
    json.dump(geojson, fp, ensure_ascii=False)
print('已导出:', path)
