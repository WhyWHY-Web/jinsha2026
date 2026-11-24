# -*- coding: utf-8 -*-
"""下载 Terrarium 真实高程瓦片并生成 190m DEM（4096²）。

数据源：Mapzen/AWS Terrarium 高程瓦片（SRTM30 + GMTED + ETOPO 融合），z=10 原生 ~133 m/px，
足够支撑 190 m 输出。全流域约 506 张瓦片，并行 + 磁盘缓存，可断点续跑。
"""
import os, io, math, time, urllib.request, concurrent.futures
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data'); IMG = os.path.join(ROOT, 'web', 'assets', 'img')
LON_MIN, LON_MAX, LAT_MIN, LAT_MAX = 97.6, 105.4, 25.9, 32.5
Z = 10
N = 4096                      # ≈185 m/格点，即"190m DEM"
UA = {'User-Agent': 'Mozilla/5.0 (research; jinsha-digital-twin)'}
CACHE = os.path.join(DATA, 'tiles_dem', str(Z))

def lon2x(lon, z):
    return (lon + 180.0) / 360.0 * (2 ** z)

def lat2y(lat, z):
    r = np.radians(np.float64(lat))
    return (1.0 - np.log(np.tan(r) + 1.0 / np.cos(r)) / np.pi) / 2.0 * (2 ** z)

x0, x1 = int(lon2x(LON_MIN, Z)), int(lon2x(LON_MAX, Z))
y0, y1 = int(lat2y(LAT_MAX, Z)), int(lat2y(LAT_MIN, Z))
nx, ny = x1 - x0 + 1, y1 - y0 + 1
print('tiles %d x %d = %d (z=%d)' % (nx, ny, nx * ny, Z))

def fetch_tile(tx, ty):
    p = os.path.join(CACHE, str(tx), '%d.png' % ty)
    if os.path.exists(p) and os.path.getsize(p) > 200:
        try:
            return tx, ty, np.asarray(Image.open(p).convert('RGB')).astype(np.float32)
        except Exception:
            pass
    url = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png' % (Z, tx, ty)
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45) as r:
                raw = r.read()
            a = np.asarray(Image.open(io.BytesIO(raw)).convert('RGB')).astype(np.float32)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, 'wb') as f:
                f.write(raw)
            return tx, ty, a
        except Exception:
            time.sleep(1.0)
    return tx, ty, None

mos = np.zeros((ny * 256, nx * 256), dtype=np.float32)
miss = 0
done = 0
tiles = [(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    for tx, ty, a in ex.map(lambda t: fetch_tile(t[0], t[1]), tiles):
        done += 1
        if a is None:
            miss += 1
            print('  miss %d,%d' % (tx, ty))
            continue
        e = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256.0 - 32768.0
        mos[(ty - y0) * 256:(ty - y0) * 256 + 256, (tx - x0) * 256:(tx - x0) * 256 + 256] = e
        if done % 100 == 0 or done == len(tiles):
            print('  %d/%d  (miss %d)' % (done, len(tiles), miss))
print('mosaic', mos.shape, 'min %.0f max %.0f' % (mos.min(), mos.max()))

# 采样到经纬度网格 4096²（≈185 m）
lons = LON_MIN + (np.arange(N) + .5) / N * (LON_MAX - LON_MIN)
lats = LAT_MAX - (np.arange(N) + .5) / N * (LAT_MAX - LAT_MIN)
px = lon2x(lons, Z) * 256 - x0 * 256
py = lat2y(lats, Z) * 256 - y0 * 256
px = np.clip(px, 0, mos.shape[1] - 1.001)
py = np.clip(py, 0, mos.shape[0] - 1.001)
ix = px.astype(np.int32); iy = py.astype(np.int32)
fx = (px - ix).astype(np.float32); fy = (py - iy).astype(np.float32)
jx = np.minimum(ix + 1, mos.shape[1] - 1); jy = np.minimum(iy + 1, mos.shape[0] - 1)
dem = np.empty((N, N), dtype=np.float32)
for j in range(N):
    w = (1.0 - fy[j])
    dem[j] = (mos[iy[j], ix] * (1 - fx) * w + mos[iy[j], jx] * fx * w +
              mos[jy[j], ix] * (1 - fx) * fy[j] + mos[jy[j], jx] * fx * fy[j])
dem = np.clip(dem, 0, 9000)
print('dem', dem.shape, 'min %.0f max %.0f mean %.0f' % (dem.min(), dem.max(), dem.mean()))
dem.astype('<i2').tofile(os.path.join(DATA, 'dem.bin'))
print('dem.bin bytes', os.path.getsize(os.path.join(DATA, 'dem.bin')))

# 山体阴影（2048，供可能的离线晕渲使用）
E = np.asarray(Image.fromarray(dem.astype(np.float32)).resize((2048, 2048), Image.BICUBIC), dtype=np.float32)
cell = (LON_MAX - LON_MIN) * 111320 * math.cos(math.radians(29)) / 2048
gy, gx = np.gradient(E, cell)
slope = np.arctan(np.hypot(gx, gy))
aspect = np.arctan2(gy, -gx)
az, alt = math.radians(315), math.radians(42)
hs = (np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
hs = np.clip(hs, 0, 1); hs = 0.35 + 0.65 * hs
hs = np.clip((hs - .5) * 1.12 + .5, 0, 1)
Image.fromarray((hs * 255).astype('uint8')).save(os.path.join(IMG, 'hillshade.jpg'), quality=86, optimize=True)
print('slope mean %.1f° p90 %.1f°' % (np.degrees(slope).mean(), np.degrees(np.percentile(slope, 90))))
print('DONE')
