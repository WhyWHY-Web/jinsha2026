# -*- coding: utf-8 -*-
"""
为每个站点生成「实景补丁」：10 km 见方的高精度地形 + 高分辨率影像。

为什么要单独做
  全域地形是 742 m 网格、影像约 520 m/px，缩到几百米尺度就是一片糊。
  补丁用 30 m DEM（Copernicus GLO-30）+ z15 影像（约 4 m/px），
  近景才挂上去，远景仍然用全域地形，两边坐标和高度基准完全对齐。

数据源
  高程  Copernicus DEM GLO-30（AWS Open Data，30 m）
        经 STAC 检索：https://earth-search.aws.element84.com/v1/collections/cop-dem-glo-30
  影像  Esri World Imagery 瓦片 z15（与三维全域贴图同源）

输出
  data/detail.json          清单：每站 bbox / 网格尺寸 / 高程范围 / 文件路径
  data/detail/<名>_dem.bin  int16 小端高程，N×N
  data/detail/<名>.jpg      影像 IMG×IMG

用法
  python tools/build_detail.py                 # 20 站，半径 0.13°（约 28 km）
  python tools/build_detail.py --radius 0.05   # 缩小范围
  python tools/build_detail.py --corridor      # 额外生成相邻站点中点，让干流连成走廊
"""
import io, json, math, os, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTDIR = os.path.join(ROOT, 'data', 'detail')
MANIFEST = os.path.join(ROOT, 'data', 'detail.json')
STATIONS = os.path.join(ROOT, 'data', 'stations.json')

N = 512                      # 高程网格边长（30 m × 512 ≈ 28 km 内 55 m/格）
IMG = 2048                   # 影像边长
Z = 15                       # Esri 瓦片层级（导出模式不使用，仅作记录）
STAC = 'https://earth-search.aws.element84.com/v1/search'
EXPORT = ('https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/'
          'MapServer/export?bbox=%s&bboxSR=4326&imageSR=4326&size=%d,%d&format=jpg&f=image')


def http_json(url, body=None, timeout=90):
    data = json.dumps(body).encode() if body is not None else None
    hdr = {'Content-Type': 'application/json'} if body is not None else {}
    req = urllib.request.Request(url, data=data, headers=hdr)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


_GLOBAL = None

def _global_dem():
    """全域 1024² DEM，用于给补丁的个别空洞兜底（不会被当成主数据）。"""
    global _GLOBAL
    if _GLOBAL is None:
        import numpy as np
        _GLOBAL = np.fromfile(os.path.join(ROOT, 'data', 'dem.bin'), dtype='<i2').reshape(1024, 1024)
    return _GLOBAL


def dem_window(bbox, n):
    """从 Copernicus GLO-30 读窗口并重采样到 n×n。

    注意两个坑：
      1. 10 km 的框经常跨 1°×1° 瓦片，只取第一个瓦片会把另一半填成 0；
      2. 瓦片自带 0 值边界。
    所以这里把范围内**所有**瓦片合并，剩下的空洞再用全域 DEM 兜底。
    """
    import numpy as np
    import rasterio
    from rasterio.merge import merge

    q = {'collections': ['cop-dem-glo-30'], 'bbox': list(bbox), 'limit': 10}
    feats = http_json(STAC, q)['features']
    if not feats:
        raise RuntimeError('该范围没有 30 m DEM 覆盖')

    srcs, arr = [], None
    try:
        for f in feats:
            href = f['assets']['data']['href']
            url = href.replace('s3://copernicus-dem-30m/', 'https://copernicus-dem-30m.s3.amazonaws.com/')
            srcs.append(rasterio.open(url))
        arr, _ = merge(srcs, bounds=bbox, nodata=0)
        arr = arr[0]
    finally:
        for s in srcs:
            try: s.close()
            except Exception: pass

    # 重采样到 n×n
    if arr.shape != (n, n):
        yi = (np.linspace(0, arr.shape[0] - 1, n)).astype(int)
        xi = (np.linspace(0, arr.shape[1] - 1, n)).astype(int)
        arr = arr[np.ix_(yi, xi)]

    # 0 值 / 负值视为空洞，用全域 DEM 兜底
    bad = arr <= 0
    if bad.any():
        g = _global_dem()
        lon0, lat0, lon1, lat1 = bbox
        for j, i in zip(*np.where(bad)):
            lon = lon0 + (lon1 - lon0) * (i + 0.5) / n
            lat = lat1 - (lat1 - lat0) * (j + 0.5) / n
            x = int((lon - 97.6) / (105.4 - 97.6) * 1024)
            y = int((32.5 - lat) / (32.5 - 25.9) * 1024)
            x = max(0, min(1023, x)); y = max(0, min(1023, y))
            arr[j, i] = g[y, x]
    return arr.astype('int16')


def merc(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    s = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n
    return x, y


def imagery(bbox, size):
    """用 Esri export 一次拿到整幅影像（比逐瓦片拼快一个数量级，且边缘无错位）。"""
    from PIL import Image
    url = EXPORT % (','.join(str(round(v, 6)) for v in bbox), size, size)
    last = None
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'JinshaEco/2.0'})
            with urllib.request.urlopen(req, timeout=90) as r:
                raw = r.read()
            return Image.open(io.BytesIO(raw)).convert('RGB').resize((size, size), Image.LANCZOS)
        except Exception as e:
            last = e
            time.sleep(3 + i * 3)
    raise RuntimeError('影像导出失败：%s' % last)


def main():
    only = None
    radius = 0.13
    corridor = False
    for i, a in enumerate(sys.argv):
        if a == '--only' and i + 1 < len(sys.argv): only = sys.argv[i + 1]
        if a == '--radius' and i + 1 < len(sys.argv): radius = float(sys.argv[i + 1])
        if a == '--corridor': corridor = True
    os.makedirs(OUTDIR, exist_ok=True)

    sts = json.load(open(STATIONS, encoding='utf-8'))['stations']
    targets = [{'name': s['name'], 'lon': s['lon'], 'lat': s['lat'], 'kind': '站点'}
               for s in sts]
    if corridor:
        # 相邻站点连线中点各补一块，干流就连成连续走廊（相邻补丁会互相重叠）
        for a, b in zip(sts, sts[1:]):
            targets.append({'name': '%s—%s' % (a['name'], b['name']),
                            'lon': (a['lon'] + b['lon']) / 2,
                            'lat': (a['lat'] + b['lat']) / 2, 'kind': '走廊'})
    if only:
        targets = [t for t in targets if t['name'] == only or t['name'].startswith(only + '—')]
    print('生成 %d 块实景补丁（±%.3f° ≈ ±%.0f km，DEM %d²，影像 %d²）'
          % (len(targets), radius, radius * 111, N, IMG))

    man = {'n': N, 'img': IMG, 'radius': radius,
           'demSource': 'Copernicus DEM GLO-30', 'imgSource': 'Esri World Imagery（export 2048²）',
           'fetched': time.strftime('%Y-%m-%d %H:%M'), 'stations': {}}
    from concurrent.futures import ThreadPoolExecutor

    def build(t):
        lon, lat = t['lon'], t['lat']
        bbox = (lon - radius, lat - radius, lon + radius, lat + radius)
        t0 = time.time()
        arr = dem_window(bbox, N)
        im = imagery(bbox, IMG)
        return t, bbox, arr, im, time.time() - t0

    done = [0]
    lock = __import__('threading').Lock()
    with ThreadPoolExecutor(max_workers=4) as ex:
        for t, bbox, arr, im, cost in ex.map(build, targets):
            fn = t['name']
            arr.tofile(os.path.join(OUTDIR, fn + '_dem.bin'))
            im.save(os.path.join(OUTDIR, fn + '.jpg'), quality=80, optimize=True)
            man['stations'][t['name']] = {
                'bbox': [round(v, 6) for v in bbox],
                'elev': [int(arr.min()), int(arr.max())],
                'kind': t['kind'],
                'dem': 'detail/%s_dem.bin' % fn, 'img': 'detail/%s.jpg' % fn,
            }
            with lock:
                done[0] += 1
                print('  %2d/%d %-14s 高程 %5d–%5d m  %.0fs'
                      % (done[0], len(targets), fn, arr.min(), arr.max(), cost), flush=True)

    json.dump(man, open(MANIFEST, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n写出 %s（%d 块）' % (MANIFEST, len(man['stations'])))


if __name__ == '__main__':
    os.environ.setdefault('GDAL_HTTP_UNSAFESSL', 'YES')
    os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
    os.environ.setdefault('AWS_NO_SIGN_REQUEST', 'YES')
    main()
