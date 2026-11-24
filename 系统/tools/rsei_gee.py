# -*- coding: utf-8 -*-
"""
金沙江流域 RSEI 计算（徐涵秋 2013 方法，对标洱海论文）
四分量：绿度 NDVI、湿度 WET(缨帽)、干度 NDSI=(SI+IBI)/2、热度 LST(ST波段)
流程：生长季中值合成 + 云掩膜 -> 四分量 -> min-max(2%/98%)归一化 -> PCA 取 PC1 -> RSEI -> 5级分级 -> 统计

用法：
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY   # GEE 需直连
  python tools/rsei_gee.py --year 2020                 # 单期
  python tools/rsei_gee.py --year 2020 --stats-only    # 只统计（跳过栅格导出）
  python tools/rsei_gee.py --years 1990,1995,...,2025  # 批量
"""
import argparse, ee, json, os, sys
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASIN = os.path.join(ROOT, 'data', 'basin', 'jinsha_basin.geojson')
OUT = os.path.join(ROOT, 'data', 'rsei')
os.makedirs(OUT, exist_ok=True)

# ---- 传感器配置 --------------------------------------------------------------
# 统一波段名: blue, green, red, nir, swir1, swir2, thermal
SENSORS = {
    'L5': {  # TM
        'coll': 'LANDSAT/LT05/C02/T1_L2',
        'bands': {'blue': 'SR_B1', 'green': 'SR_B2', 'red': 'SR_B3', 'nir': 'SR_B4',
                  'swir1': 'SR_B5', 'swir2': 'SR_B7', 'thermal': 'ST_B6'},
        'wet': [0.0315, 0.2021, 0.3102, 0.1594, -0.6806, -0.6109],
    },
    'L7': {  # ETM+
        'coll': 'LANDSAT/LE07/C02/T1_L2',
        'bands': {'blue': 'SR_B1', 'green': 'SR_B2', 'red': 'SR_B3', 'nir': 'SR_B4',
                  'swir1': 'SR_B5', 'swir2': 'SR_B7', 'thermal': 'ST_B6'},
        'wet': [0.0315, 0.2021, 0.3102, 0.1594, -0.6806, -0.6109],
    },
    'L8': {  # OLI
        'coll': 'LANDSAT/LC08/C02/T1_L2',
        'bands': {'blue': 'SR_B2', 'green': 'SR_B3', 'red': 'SR_B4', 'nir': 'SR_B5',
                  'swir1': 'SR_B6', 'swir2': 'SR_B7', 'thermal': 'ST_B10'},
        'wet': [0.1511, 0.1973, 0.3283, 0.3407, -0.7117, -0.4559],
    },
    'L9': {  # OLI-2
        'coll': 'LANDSAT/LC09/C02/T1_L2',
        'bands': {'blue': 'SR_B2', 'green': 'SR_B3', 'red': 'SR_B4', 'nir': 'SR_B5',
                  'swir1': 'SR_B6', 'swir2': 'SR_B7', 'thermal': 'ST_B10'},
        'wet': [0.1511, 0.1973, 0.3283, 0.3407, -0.7117, -0.4559],
    },
}
SR_SCALE, SR_OFFSET = 0.0000275, -0.2
ST_SCALE, ST_OFFSET = 0.00341802, 149.0

# 传感器可用年代
YEAR_SENSORS = [(1984, 'L5'), (1999, 'L7'), (2013, 'L8'), (2021, 'L9')]

def pick_sensor(year):
    s = 'L5'
    for y, sn in YEAR_SENSORS:
        if year >= y:
            s = sn
    return s

def load_aoi():
    with open(BASIN, encoding='utf-8') as fp:
        gj = json.load(fp)
    feats = [ee.Feature(ee.Geometry(f['geometry'])) for f in gj['features']]
    fc = ee.FeatureCollection(feats)
    return fc, fc.geometry()

def cloud_mask(img):
    qa = img.select('QA_PIXEL')
    cloud = qa.bitwiseAnd(1 << 3).eq(0)
    shadow = qa.bitwiseAnd(1 << 4).eq(0)
    snow = qa.bitwiseAnd(1 << 5).eq(0)
    return img.updateMask(cloud.And(shadow).And(snow))

def scale_sr(img, cfg):
    # 地表反射率定标 + 统一波段名
    b = cfg['bands']
    return (img.select(list(b.values()), list(b.keys()))
               .multiply(SR_SCALE).add(SR_OFFSET)
               .clamp(0, 1.2))

def scale_st(img, cfg):
    b = cfg['bands']
    return (img.select(b['thermal']).multiply(ST_SCALE).add(ST_OFFSET)
               .rename('thermal'))

def composite(year):
    """生长季(6-9月)云掩膜后中值合成，返回统一波段的多波段影像"""
    sensor = pick_sensor(year)
    cfg = SENSORS[sensor]
    start, end = '%d-06-01' % year, '%d-09-30' % year
    col = (ee.ImageCollection(cfg['coll'])
             .filterDate(start, end).filterBounds(aoi).map(cloud_mask))
    sr = col.map(lambda i: scale_sr(i, cfg)).median()
    st = col.map(lambda i: scale_st(i, cfg)).median()
    img = sr.addBands(st)
    return img.set('SENSOR', sensor), sensor, col.size()

def four_components(img, cfg):
    blue = img.select('blue'); green = img.select('green'); red = img.select('red')
    nir = img.select('nir'); swir1 = img.select('swir1'); swir2 = img.select('swir2')
    thermal = img.select('thermal')
    # 1) 绿度 NDVI
    ndvi = nir.subtract(red).divide(nir.add(red)).rename('ndvi')
    # 2) 湿度 WET（缨帽）
    w = cfg['wet']
    wet = (blue.multiply(w[0]).add(green.multiply(w[1])).add(red.multiply(w[2]))
           .add(nir.multiply(w[3])).add(swir1.multiply(w[4])).add(swir2.multiply(w[5]))
           .rename('wet'))
    # 3) 干度 NDSI = (SI + IBI)/2
    si = swir1.add(red).subtract(nir.add(blue)).divide(swir1.add(red).add(nir.add(blue)))
    ibi_num = swir1.multiply(2).divide(swir1.add(nir)).subtract(
        nir.divide(nir.add(red)).add(green.divide(green.add(swir1))))
    ibi_den = swir1.multiply(2).divide(swir1.add(nir)).add(
        nir.divide(nir.add(red)).add(green.divide(green.add(swir1))))
    ibi = ibi_num.divide(ibi_den)
    ndsi = si.add(ibi).divide(2).rename('ndsi')
    # 4) 热度 LST（摄氏度）
    lst = thermal.subtract(273.15).rename('lst')
    return ee.Image.cat([ndvi, wet, ndsi, lst])

def normalize(stack, band):
    """2%/98% 分位 min-max 归一化"""
    img = stack.select(band)
    pr = img.reduceRegion(reducer=ee.Reducer.percentile([2, 98]), geometry=aoi,
                          scale=250, maxPixels=1e10, bestEffort=True, tileScale=4)
    lo = ee.Number(pr.get(band + '_p2'))
    hi = ee.Number(pr.get(band + '_p98'))
    return img.subtract(lo).divide(hi.subtract(lo)).clamp(0, 1).rename(band)

def pca_loadings(norm_stack):
    """流域内采样点提取四分量，Python 端算协方差矩阵求 PC1 载荷"""
    pts = norm_stack.sample(region=aoi, scale=500, numPixels=4000, seed=2024,
                            geometries=False, tileScale=4)
    feats = pts.getInfo()['features']
    X = np.array([[f['properties'][b] for b in ['ndvi', 'wet', 'ndsi', 'lst']]
                  for f in feats], dtype=float)
    X = X[~np.isnan(X).any(axis=1)]
    if X.shape[0] < 100:
        raise RuntimeError('有效采样点不足 100，检查影像覆盖')
    covarr = np.cov(X.T)
    w, v = np.linalg.eigh(covarr)   # 升序
    return v[:, -1]                 # 最大特征值对应特征向量

def compute_rsei(year):
    """计算某年 RSEI 栅格，返回 (rsei, rsei_class, sensor, n_scenes, pc1_loadings, norm)"""
    img, sensor, nscenes = composite(year)
    n = nscenes.getInfo()
    cfg = SENSORS[sensor]
    stack = four_components(img, cfg)
    norm = ee.Image.cat([normalize(stack, b) for b in ['ndvi', 'wet', 'ndsi', 'lst']])
    load = pca_loadings(norm)
    wndvi, wwet, wndsi, wlst = load
    pc1 = (norm.select('ndvi').multiply(wndvi)
           .add(norm.select('wet').multiply(wwet))
           .add(norm.select('ndsi').multiply(wndsi))
           .add(norm.select('lst').multiply(wlst)))
    rsei0 = (pc1.multiply(-1) if wndvi < 0 else pc1).rename('rsei0')
    pr = rsei0.reduceRegion(reducer=ee.Reducer.percentile([2, 98]), geometry=aoi,
                            scale=250, maxPixels=1e10, bestEffort=True, tileScale=4)
    lo = ee.Number(pr.get('rsei0_p2')); hi = ee.Number(pr.get('rsei0_p98'))
    rsei = rsei0.subtract(lo).divide(hi.subtract(lo)).clamp(0, 1).rename('rsei')
    rsei_class = (rsei.multiply(5).floor().min(4)).rename('class')
    return rsei, rsei_class, sensor, n, load, norm

def run_year(year, args):
    rsei, rsei_class, sensor, n, load, norm = compute_rsei(year)
    print('  [%d] %s 生长季影像 %d 景' % (year, sensor, n))

    scale = args.stats_scale
    mean = rsei.reduceRegion(reducer=ee.Reducer.mean(), geometry=aoi,
                             scale=scale, maxPixels=1e10, bestEffort=True, tileScale=4)
    mean4 = norm.reduceRegion(reducer=ee.Reducer.mean(), geometry=aoi,
                              scale=scale, maxPixels=1e10, bestEffort=True, tileScale=4)
    pix_area = ee.Image.pixelArea().divide(1e6)  # km²
    total_area = pix_area.updateMask(rsei.mask()).reduceRegion(
        reducer=ee.Reducer.sum(), geometry=aoi, scale=scale,
        maxPixels=1e10, bestEffort=True, tileScale=4)
    total = ee.Number(total_area.get('area')).getInfo()
    class_area = {}
    for k in range(5):
        a = pix_area.updateMask(rsei_class.eq(k)).reduceRegion(
            reducer=ee.Reducer.sum(), geometry=aoi, scale=scale,
            maxPixels=1e10, bestEffort=True, tileScale=4)
        class_area[k] = ee.Number(a.get('area'))

    res = {
        'year': year, 'sensor': sensor, 'n_scenes': int(n),
        'pc1_loadings': {'ndvi': round(float(load[0]), 6), 'wet': round(float(load[1]), 6),
                         'ndsi': round(float(load[2]), 6), 'lst': round(float(load[3]), 6)},
        'rsei_mean': round(float(mean.get('rsei').getInfo()), 6),
        'ndvi_mean': round(float(mean4.get('ndvi').getInfo()), 6),
        'wet_mean': round(float(mean4.get('wet').getInfo()), 6),
        'ndsi_mean': round(float(mean4.get('ndsi').getInfo()), 6),
        'lst_mean': round(float(mean4.get('lst').getInfo()), 6),
        'total_area_km2': round(total, 2),
    }
    for k in range(5):
        res['class_%d_pct' % k] = round(ee.Number(class_area[k]).divide(total).multiply(100).getInfo(), 3)

    path = os.path.join(OUT, 'rsei_%d.json' % year)
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(res, fp, ensure_ascii=False, indent=2)
    print('  [%d] RSEI均值=%.4f  良+优=%.1f%%  已保存 %s' %
          (year, res['rsei_mean'], res['class_3_pct'] + res['class_4_pct'], os.path.basename(path)))
    return res

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--year', type=int, default=None)
    ap.add_argument('--years', type=str, default=None, help='逗号分隔，如 1990,1995,2000')
    ap.add_argument('--stats-scale', type=int, default=250, help='统计/面积占比像元尺度(m)')
    ap.add_argument('--skip-export', action='store_true', help='跳过栅格缩略图导出')
    args = ap.parse_args()

    ee.Initialize(ee.ServiceAccountCredentials(
        json.load(open(os.path.join(ROOT, 'tools', 'gee-key.json'), encoding='utf-8'))['client_email'],
        os.path.join(ROOT, 'tools', 'gee-key.json')), project='jinsha-eco')

    global aoi
    fc, aoi = load_aoi()
    print('流域 AOI 已加载')

    if args.years:
        years = [int(y) for y in args.years.split(',') if y.strip()]
    elif args.year:
        years = [args.year]
    else:
        years = [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]
    print('计算期次:', years)

    results = []
    for y in years:
        try:
            results.append(run_year(y, args))
        except Exception as e:
            print('  [%d] 失败: %s' % (y, str(e)[:200]))
            results.append({'year': y, 'error': str(e)[:300]})

    all_path = os.path.join(OUT, 'rsei_all.json')
    with open(all_path, 'w', encoding='utf-8') as fp:
        json.dump(results, fp, ensure_ascii=False, indent=2)
    print('\n汇总已保存:', all_path)

if __name__ == '__main__':
    main()
