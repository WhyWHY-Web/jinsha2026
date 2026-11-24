# -*- coding: utf-8 -*-
"""离线影像瓦片下载器（XYZ / Web Mercator）

用途：把金沙江流域的卫星影像按层级抓成本地瓦片，供 Cesium / Three.js 离线使用。

为什么不能"全域 z17"：
    全域 (97.6–105.4E, 25.9–32.5N) 在 z17 是 782 万块瓦片、约 112 GB。
    合理做法是分层：
        全域 z9–z12   约 15 万块 / 150 MB   远景到 ~38 m/px
        干流走廊 z13–z16  约 9 千块 / 130 MB  近景到 ~2.4 m/px
        重点样区 z17   3 个 8×8 km 约 2 千块 / 30 MB  到 ~0.6 m/px

用法：
    python tools/make_tiles.py --probe                 # 只测连通性与体积，不下载
    python tools/make_tiles.py --zmin 9 --zmax 12     # 全域底图
    python tools/make_tiles.py --corridor --zmin 13 --zmax 16   # 干流走廊
    python tools/make_tiles.py --area 102.6,26.9,103.3,27.5 --zmin 15 --zmax 17

输出：data/tiles/{z}/{x}/{y}.jpg（已存在则跳过，可断点续传）
"""
from __future__ import print_function
import argparse
import json
import math
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'tiles')
BBOX = (97.6, 25.9, 105.4, 32.5)      # 流域范围

# 免费、无需密钥的影像源（按优先级尝试）
SOURCES = [
    ('EOX Sentinel-2 cloudless',
     'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'),
    ('Esri World Imagery',
     'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'),
]


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.log(math.tan(math.radians(lat)) + 1.0 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tile_range(bbox, z):
    w, s, e, n = bbox
    x0, y1 = lonlat_to_tile(w, s, z)
    x1, y0 = lonlat_to_tile(e, n, z)
    return int(x0), int(x1), int(y0), int(y1)


def count_tiles(bbox, zmin, zmax):
    tot = 0
    for z in range(zmin, zmax + 1):
        x0, x1, y0, y1 = tile_range(bbox, z)
        tot += (x1 - x0 + 1) * (y1 - y0 + 1)
    return tot


def load_corridor():
    """干流走廊：取 streams.json 里最长的一条线（干流），沿线每点外扩 0.12°。"""
    fp = os.path.join(ROOT, 'data', 'streams.json')
    try:
        d = json.load(open(fp, encoding='utf-8'))
    except Exception:
        return []
    lines = d.get('lines') or []
    # 每条线是 [order, [[lon,lat], ...]]
    best = max(lines, key=lambda l: len(l[1])) if lines else None
    if not best or not best[1]:
        return []
    pts = best[1]
    step = max(1, len(pts) // 160)
    boxes = []
    for k in range(0, len(pts), step):
        p = pts[k]
        lon, lat = float(p[0]), float(p[1])
        boxes.append((lon - 0.12, lat - 0.12, lon + 0.12, lat + 0.12))
    return boxes


def fetch(url, dst, timeout=25):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; JinshaEco/2.0 offline tile cache)',
        'Accept': 'image/jpeg,image/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if len(data) < 500:
        raise ValueError('内容过短 %d 字节' % len(data))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'wb') as f:
        f.write(data)
    return len(data)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zmin', type=int, default=9)
    ap.add_argument('--zmax', type=int, default=12)
    ap.add_argument('--bbox', default=None, help='w,s,e,n')
    ap.add_argument('--area', action='append', default=[], help='w,s,e,n（可多次）')
    ap.add_argument('--corridor', action='store_true', help='只抓干流走廊')
    ap.add_argument('--probe', action='store_true', help='只估算，不下载')
    ap.add_argument('--limit', type=int, default=0, help='最多下载多少块（调试用）')
    a = ap.parse_args()

    boxes = []
    if a.bbox:
        boxes.append(tuple(float(v) for v in a.bbox.split(',')))
    for s in a.area:
        boxes.append(tuple(float(v) for v in s.split(',')))
    if a.corridor:
        boxes.extend(load_corridor())
    if not boxes:
        boxes = [BBOX]

    _uniq = set()
    for _b in boxes:
        for _z in range(a.zmin, a.zmax + 1):
            _x0, _x1, _y0, _y1 = tile_range(_b, _z)
            for _x in range(_x0, _x1 + 1):
                for _y in range(_y0, _y1 + 1):
                    _uniq.add((_z, _x, _y))
    total = len(_uniq)
    print('层级 z%d–z%d，区域 %d 个，预计 %s 块 ≈ %.0f MB'
          % (a.zmin, a.zmax, len(boxes), format(total, ','), total * 15 / 1024))
    if a.probe:
        print('\n各层明细：')
        for z in range(a.zmin, a.zmax + 1):
            n = sum(1 for t in _uniq if t[0] == z)
            print('  z%-2d  %8s 块  ≈ %5.0f MB' % (z, format(n, ','), n * 15 / 1024))
        return

    tasks = []
    for b in boxes:
        for z in range(a.zmin, a.zmax + 1):
            x0, x1, y0, y1 = tile_range(b, z)
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    tasks.append((z, x, y))
    # 去重（走廊相邻包围盒会重叠）
    tasks = sorted(set(tasks))
    if a.limit:
        tasks = tasks[:a.limit]

    stat = {'done': 0, 'skip': 0, 'fail': 0, 'bytes': 0}
    t0 = time.time()

    def one(t):
        z, x, y = t
        dst = os.path.join(OUT, str(z), str(x), '%d.jpg' % y)
        if os.path.exists(dst) and os.path.getsize(dst) > 500:
            stat['skip'] += 1
            return
        for name, tpl in SOURCES:
            try:
                stat['bytes'] += fetch(tpl.format(z=z, x=x, y=y), dst)
                stat['done'] += 1
                return
            except Exception:
                continue
        stat['fail'] += 1

    with ThreadPoolExecutor(max_workers=16) as pool:
        futs = [pool.submit(one, t) for t in tasks]
        for k, _ in enumerate(as_completed(futs), 1):
            if k % 500 == 0:
                el = time.time() - t0
                print('  …%d/%d  新 %d · 失败 %d · %.1f MB · %.0f 块/分'
                      % (k, len(tasks), stat['done'], stat['fail'],
                         stat['bytes'] / 1048576, k / max(1e-6, el) * 60), flush=True)

    print('完成：新下载 %d · 跳过 %d · 失败 %d · %.1f MB · %.0f s'
          % (stat['done'], stat['skip'], stat['fail'], stat['bytes'] / 1048576, time.time() - t0))
    print('输出目录：%s' % OUT)


if __name__ == '__main__':
    main()
