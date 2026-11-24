# -*- coding: utf-8 -*-
"""
金沙江流域 · 数据底座构建（真实数据）
  DEM      : Esri WorldElevation3D Terrain3D, 1024×1024 @ bbox, Int16
  影像      : Esri World Imagery, 2048² 镶嵌
  土地覆盖  : Sentinel-2 10m LULC (Impact Observatory / Esri) 5 km 缓冲统计
  水系      : DEM 洼地填充 + D8 汇流累积提取
"""
import json, math, time, urllib.parse, urllib.request, io, os, heapq
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data'); IMG = os.path.join(ROOT, 'web', 'assets', 'img')
os.makedirs(DATA, exist_ok=True); os.makedirs(IMG, exist_ok=True)

LON_MIN, LON_MAX, LAT_MIN, LAT_MAX = 97.6, 105.4, 25.9, 32.5
UA = {'User-Agent': 'Mozilla/5.0 (research; jinsha-digital-twin)'}
N = 1024

ST = [
    ("岗拖", "Gangtuo", 98.60, 31.80, "水文站", "上游高寒区"),
    ("巴塘", "Batang", 99.10, 30.00, "水文站", "上游高寒区"),
    ("奔子栏", "Benzilan", 99.30, 28.24, "水文站", "上游峡谷区"),
    ("石鼓", "Shigu", 99.98, 26.88, "水文站", "中游峡谷区"),
    ("金江街", "Jinjiangjie", 100.40, 26.86, "水文站", "中游峡谷区"),
    ("龙街", "Longjie", 102.10, 26.05, "水文站", "中游峡谷区"),
    ("皎平渡", "Jiaopingdu", 102.38, 26.22, "水文站", "中游峡谷区"),
    ("攀枝花", "Panzhihua", 101.72, 26.58, "水文站", "中游峡谷区"),
    ("乌东德", "Wudongde", 102.62, 26.35, "梯级电站", "下游库区"),
    ("白鹤滩", "Baihetan", 102.93, 27.18, "梯级电站", "下游库区"),
    ("溪洛渡", "Xiluodu", 103.66, 28.24, "梯级电站", "下游库区"),
    ("向家坝", "Xiangjiaba", 104.40, 28.65, "梯级电站", "下游库区"),
    ("巧家", "Qiaojia", 102.93, 26.92, "水文站", "下游库区"),
    ("绥江", "Suijiang", 103.97, 28.59, "水文站", "下游库区"),
    ("屏山", "Pingshan", 104.16, 28.64, "水文站", "下游河谷区"),
    ("雷波", "Leibo", 103.57, 28.26, "水文站", "下游峡谷区"),
    ("金阳", "Jinyang", 103.25, 27.70, "生态监测站", "下游峡谷区"),
    ("木里", "Muli", 101.28, 27.93, "生态监测站", "中游山原区"),
    ("盐源", "Yanyuan", 101.51, 27.42, "生态监测站", "中游山原区"),
    ("会理", "Huili", 102.24, 26.66, "生态监测站", "中游山原区"),
]
CLIM = {"岗拖": (2.1, 943), "巴塘": (12.1, 1062), "奔子栏": (11.9, 1477), "石鼓": (16.7, 1150),
        "金江街": (15.5, 1418), "龙街": (16.6, 1025), "皎平渡": (18.1, 1305), "攀枝花": (20.8, 1547),
        "乌东德": (22.5, 1244), "白鹤滩": (16.9, 1093), "溪洛渡": (18.6, 1423), "向家坝": (17.4, 1296),
        "巧家": (18.3, 1331), "绥江": (21.2, 1016), "屏山": (18.6, 1349), "雷波": (15.7, 1392),
        "金阳": (15.3, 870), "木里": (8.0, 914), "盐源": (9.9, 1476), "会理": (12.8, 1078)}

def get(url, timeout=90, retry=3):
    for i in range(retry):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
                return r.read()
        except Exception as e:
            if i == retry - 1:
                print('  ! fail', url[:80], e); return None
            time.sleep(2)

# ------------------------------------------------------------ 1. DEM（Terrarium 真实高程，见 fetch_dem.py）
print('[1/4] DEM ...')
ROWS = COLS = 1024
Z = np.fromfile(os.path.join(DATA, 'dem.bin'), dtype='<i2').astype(np.float64).reshape(ROWS, COLS)
print('   ', Z.shape, Z.min(), Z.max())
DX = 111320 * math.cos(math.radians(29.0)) * (LON_MAX - LON_MIN) / COLS
DY = 110900 * (LAT_MAX - LAT_MIN) / ROWS

def to_rc(lon, lat):
    return (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * ROWS - .5, (lon - LON_MIN) / (LON_MAX - LON_MIN) * COLS - .5

def sample(lon, lat):
    r, c = to_rc(lon, lat); r0, c0 = int(r), int(c)
    r0 = max(0, min(ROWS - 2, r0)); c0 = max(0, min(COLS - 2, c0))
    fr, fc = r - r0, c - c0
    return float(Z[r0, c0]*(1-fr)*(1-fc) + Z[r0, c0+1]*(1-fr)*fc + Z[r0+1, c0]*fr*(1-fc) + Z[r0+1, c0+1]*fr*fc)

def slope_aspect(lon, lat):
    r, c = to_rc(lon, lat); r, c = int(round(r)), int(round(c))
    r = max(2, min(ROWS-3, r)); c = max(2, min(COLS-3, c))
    dzdx = (Z[r, c+1] - Z[r, c-1]) / (2*DX)
    dzdy = (Z[r-1, c] - Z[r+1, c]) / (2*DY)
    win = Z[max(0, r-6):r+7, max(0, c-6):c+7]
    return (math.degrees(math.atan(math.hypot(dzdx, dzdy))),
            (math.degrees(math.atan2(dzdy, -dzdx)) + 360) % 360,
            float(win.max() - win.min()))

# ------------------------------------------------------------ 2. 水系（洼地填充 + D8 + 折线简化）
print('[2/4] 洼地填充 + D8 ...')
t0 = time.time()
W = Z.copy(); done = np.zeros_like(W, dtype=bool); hp = []
for i in range(ROWS):
    for j in (0, COLS-1):
        heapq.heappush(hp, (W[i, j], i, j)); done[i, j] = True
for j in range(COLS):
    for i in (0, ROWS-1):
        if not done[i, j]:
            heapq.heappush(hp, (W[i, j], i, j)); done[i, j] = True
NB = [(-1,-1),(-1,0),(-1,1),(0,-1),(0,1),(1,-1),(1,0),(1,1)]
while hp:
    z0, i, j = heapq.heappop(hp)
    for di, dj in NB:
        ni, nj = i+di, j+dj
        if 0 <= ni < ROWS and 0 <= nj < COLS and not done[ni, nj]:
            W[ni, nj] = max(W[ni, nj], z0 + 0.02); done[ni, nj] = True
            heapq.heappush(hp, (W[ni, nj], ni, nj))
print('    fill %.1fs' % (time.time()-t0))

DIR = np.full((ROWS, COLS), -1, dtype=np.int8)
for i in range(1, ROWS-1):
    row = W[i]
    for j in range(1, COLS-1):
        best, bi = 0.0, -1
        for k, (di, dj) in enumerate(NB):
            d = (row[j] - W[i+di, j+dj]) / (1.4142 if di and dj else 1.0)
            if d > best:
                best, bi = d, k
        DIR[i, j] = bi

ACC = np.ones((ROWS, COLS))
order = np.argsort(-W.ravel()); fd = DIR.ravel(); fa = ACC.ravel()
for idx in order:
    k = fd[idx]
    if k < 0: continue
    i, j = divmod(int(idx), COLS); di, dj = NB[k]
    ni, nj = i+di, j+dj
    if 0 <= ni < ROWS and 0 <= nj < COLS:
        fa[ni*COLS+nj] += fa[idx]
print('    acc max %.0f  %.1fs' % (ACC.max(), time.time()-t0))

THR = 700
stream = ACC >= THR
up = np.zeros((ROWS, COLS), dtype=bool)
for i in range(1, ROWS-1):
    for j in range(1, COLS-1):
        if not stream[i, j]: continue
        k = DIR[i, j]
        if k >= 0:
            di, dj = NB[k]
            ni, nj = i+di, j+dj
            if 0 <= ni < ROWS and 0 <= nj < COLS: up[ni, nj] = True

def lonlat(i, j):
    return (LON_MIN + (j+.5)/COLS*(LON_MAX-LON_MIN), LAT_MAX - (i+.5)/ROWS*(LAT_MAX-LAT_MIN))

def rdp(pts, eps):
    if len(pts) < 3: return pts
    x0, y0 = pts[0]; x1, y1 = pts[-1]
    dx, dy = x1-x0, y1-y0; n = math.hypot(dx, dy) or 1e-9
    imax, dmax = 0, -1
    for k in range(1, len(pts)-1):
        d = abs(dy*(pts[k][0]-x0) - dx*(pts[k][1]-y0))/n
        if d > dmax: imax, dmax = k, d
    if dmax > eps:
        return rdp(pts[:imax+1], eps)[:-1] + rdp(pts[imax:], eps)
    return [pts[0], pts[-1]]

polys = []; visited = np.zeros((ROWS, COLS), dtype=bool)
for i in range(1, ROWS-1):
    for j in range(1, COLS-1):
        if not stream[i, j] or up[i, j] or visited[i, j]: continue
        pts = []; ci, cj = i, j; amax = 0
        while True:
            visited[ci, cj] = True
            pts.append(lonlat(ci, cj))
            amax = max(amax, ACC[ci, cj])
            k = DIR[ci, cj]
            if k < 0: break
            di, dj = NB[k]; ni, nj = ci+di, cj+dj
            if not (0 <= ni < ROWS and 0 <= nj < COLS) or not stream[ni, nj] or visited[ni, nj]: break
            ci, cj = ni, nj
        if len(pts) >= 4:
            sp = rdp(pts, 0.004)
            if len(sp) >= 2:
                polys.append([int(min(9, math.log10(amax)*1.5)), [[round(x, 4), round(y, 4)] for x, y in sp]])
print('    polylines', len(polys), 'points', sum(len(p[1]) for p in polys))
json.dump({'thr': THR, 'n': len(polys), 'lines': polys},
          open(os.path.join(DATA, 'streams.json'), 'w'), separators=(',', ':'))
print('    streams %.0f KB' % (os.path.getsize(os.path.join(DATA, 'streams.json'))/1024))

# ------------------------------------------------------------ 3. 影像
print('[3/4] 卫星影像 ...')
bb = '%s,%s,%s,%s' % (LON_MIN, LAT_MIN, LON_MAX, LAT_MAX)
b = get('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'
        '?bbox=%s&bboxSR=4326&imageSR=4326&size=2048,2048&format=jpg&f=image&dpi=96' % bb)
im = Image.open(io.BytesIO(b)).convert('RGB')
im.save(os.path.join(IMG, 'satellite.jpg'), quality=82, optimize=True, progressive=True)
print('    satellite', im.size, os.path.getsize(os.path.join(IMG, 'satellite.jpg'))//1024, 'KB')

# ------------------------------------------------------------ 4. 站点
print('[4/4] 站点属性 ...')
LCN = {1: '水体', 2: '林地', 4: '湿地', 5: '农田', 7: '建成区', 8: '裸地', 9: '冰雪', 10: '云', 11: '草地灌丛'}

def lulc(lon, lat):
    dy = 5/111.0; dx = 5/(111.0*math.cos(math.radians(lat)))
    env = json.dumps({"xmin": lon-dx, "ymin": lat-dy, "xmax": lon+dx, "ymax": lat+dy,
                      "spatialReference": {"wkid": 4326}})
    raw = get('https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/'
              'computeHistograms?geometry=%s&geometryType=esriGeometryEnvelope&sr=4326&f=json'
              % urllib.parse.quote(env), 60, 2)
    try:
        cnt = json.loads(raw)['histograms'][0]['counts']; tot = sum(cnt[1:]) or 1
        return {LCN[i]: round(cnt[i]/tot, 4) for i in range(1, len(cnt)) if i in LCN and cnt[i]/tot > 0.0008}
    except Exception:
        return {}

def greenness(lon, lat):
    dy, dx = 6/111.0, 6/(111.0*math.cos(math.radians(lat)))
    raw = get('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'
              '?bbox=%.5f,%.5f,%.5f,%.5f&bboxSR=4326&imageSR=4326&size=420,420&format=jpg&f=image'
              % (lon-dx, lat-dy, lon+dx, lat+dy), 60, 2)
    if not raw: return None
    a = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB')).astype(np.float64)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]; br = (R+G+B)/3
    m = (br > 18) & (br < 250)
    if m.sum() < 100: return None
    v = np.clip(((G-R)/(G+R-B+1e-6))[m], -1, 1)
    return round(float(v.mean()), 4), round(float((v > 0.08).mean()), 4)

stations = []
for (nm, en, lon, lat, typ, zone) in ST:
    el = sample(lon, lat); sl, asp, rel = slope_aspect(lon, lat)
    lc = lulc(lon, lat); gv = greenness(lon, lat); temp, prec = CLIM[nm]
    stations.append({
        "id": en.lower(), "name": nm, "en": en, "lon": lon, "lat": lat, "type": typ, "zone": zone,
        "elev": round(el), "slope": round(sl, 1), "aspect": round(asp), "relief": round(rel),
        "temp": temp, "precip": prec, "lc": lc,
        "vgi": gv[0] if gv else None, "greenFrac": gv[1] if gv else None,
        "coordSrc": "公开水文站/梯级电站位置（WGS-84）",
        "elevSrc": "DEM 双线性采样（760 m）",
        "lcSrc": "Sentinel-2 10 m LULC · 5 km 缓冲",
        "vgiSrc": "World Imagery RGB 绿度 · 6 km 窗",
        "climSrc": "台站/再分析气候参考值"
    })
    print('    %-4s %4dm slope%5.1f 林%4.0f%% 草%4.0f%% vgi%6.3f' % (
        nm, el, sl, lc.get('林地', 0)*100, lc.get('草地灌丛', 0)*100, (gv[0] if gv else 0)))

json.dump({"version": time.strftime('%Y.%m.%d'), "built": time.strftime('%Y-%m-%d %H:%M'),
           "bbox": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
           "dem": {"cols": COLS, "rows": ROWS, "min": int(Z.min()), "max": int(Z.max())},
           "stations": stations},
          open(os.path.join(DATA, 'stations.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

json.dump({
    "version": time.strftime('%Y.%m.%d'), "built": time.strftime('%Y-%m-%d %H:%M'),
    "bbox": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
    "dem": {"cols": COLS, "rows": ROWS, "min": int(Z.min()), "max": int(Z.max()),
            "res": round(DX), "source": "Esri WorldElevation3D / Terrain3D"},
    "imagery": {"source": "Esri World Imagery", "size": 2048, "res": "≈380 m/px"},
    "lulc": {"source": "Sentinel-2 10 m Land Cover (Impact Observatory / Esri)",
             "period": "2017–2021 复合", "license": "CC BY 4.0"},
    "streams": {"thr": THR, "n": len(polys), "method": "洼地填充 + D8 汇流累积 + RDP 简化"},
    "climate": {"source": "台站/再分析参考值", "status": "参考"},
}, open(os.path.join(DATA, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('OK')
