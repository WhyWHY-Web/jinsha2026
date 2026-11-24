# -*- coding: utf-8 -*-
"""抓 30 m 级真实高程（AWS Terrarium 瓦片，无需密钥）

用途：给三维地形的"近景块"换成 30 m 高程，解决 742 m 格网放大后发糊的问题。

数据源：https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
    RGB 编码高程：h = (R*256 + G + B/256) - 32768   （米）
    z13 ≈ 19 m/px，z14 ≈ 9.5 m/px（在 29°N 附近）

用法：
    python tools/fetch_dem30.py --bbox 102.92,27.16,103.01,27.25 --z 14 --name 白鹤滩
    python tools/fetch_dem30.py --bbox 102.60,26.90,103.30,27.50 --z 13 --name 库区

输出：data/detail/<name>_30m.bin（Int16，行优先）+ <name>_30m.json（尺寸/范围/来源）
"""
from __future__ import print_function
import argparse
import io
import json
import math
import os
import struct
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'detail')
TPL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
TS = 256


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.log(math.tan(math.radians(lat)) + 1.0 / math.cos(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def tile_to_lonlat(x, y, z):
    n = 2 ** z
    lon = x / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    return lon, lat


def fetch(url, timeout=40):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; JinshaEco DEM fetcher)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def decode_png(data):
    """用 Pillow 解码（比手写 PNG 过滤器稳，且快 20 倍）。"""
    from PIL import Image
    im = Image.open(io.BytesIO(data)).convert('RGB')
    return im.size[0], im.size[1], im.tobytes()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bbox', required=True, help='w,s,e,n')
    ap.add_argument('--z', type=int, default=14)
    ap.add_argument('--name', default='patch')
    a = ap.parse_args()
    w, s, e, n = [float(v) for v in a.bbox.split(',')]

    x0, y0 = lonlat_to_tile(w, n, a.z)
    x1, y1 = lonlat_to_tile(e, s, a.z)
    tx0, ty0, tx1, ty1 = int(x0), int(y0), int(x1), int(y1)
    cols, rows = tx1 - tx0 + 1, ty1 - ty0 + 1
    print('范围 %.4f,%.4f,%.4f,%.4f  z%d → %d×%d 块瓦片（%d px²）'
          % (w, s, e, n, a.z, cols, rows, cols * TS))

    tiles = {}
    def one(t):
        x, y = t
        try:
            tiles[(x, y)] = fetch(TPL.format(z=a.z, x=x, y=y))
        except Exception as ex:
            print('  瓦片 %d/%d 失败：%s' % (x, y, ex))
    with ThreadPoolExecutor(max_workers=8) as p:
        list(p.map(one, [(x, y) for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1)]))

    W, H = cols * TS, rows * TS
    grid = [0] * (W * H)
    for (x, y), data in tiles.items():
        pw, ph, rgb = decode_png(data)
        ox, oy = (x - tx0) * TS, (y - ty0) * TS
        for j in range(ph):
            base = j * pw * 3
            dst = (oy + j) * W + ox
            for i in range(pw):
                k = base + i * 3
                grid[dst + i] = (rgb[k] << 8) + rgb[k + 1] - 32768

    # 空白瓦片（alpha=0 的全黑像素）会解出 -32768 一类的假值：按行用最近有效值补齐
    # 以中位数为基准做离群剔除：空白像元常解出 0 或 -32768，靠固定阈值不可靠
    valid = sorted(v for v in grid if v > 100)
    med = valid[len(valid) // 2] if valid else 0
    low = med - 1800
    bad = 0
    for j in range(H):
        row = j * W
        last = None
        for i in range(W):
            v = grid[row + i]
            if v < low:
                bad += 1
                grid[row + i] = last if last is not None else 0
            else:
                last = v
        # 行尾回归：从左到右补完后再从右往左补一次
        last = None
        for i in range(W - 1, -1, -1):
            v = grid[row + i]
            if v == 0 and last is not None and grid[row + i] == 0:
                grid[row + i] = last
            else:
                last = v
    if bad:
        print('  修正空白像元 %d 个' % bad)

    os.makedirs(OUT, exist_ok=True)
    fp = os.path.join(OUT, '%s_30m.bin' % a.name)
    with open(fp, 'wb') as f:
        f.write(struct.pack('<%dh' % (W * H), *grid))

    meta = {'name': a.name, 'bbox': [w, s, e, n], 'z': a.z,
            'width': W, 'height': H,
            'approx_m_per_px': round(156543.03392 * math.cos(math.radians((s + n) / 2)) / (2 ** a.z), 2),
            'source': 'AWS Terrain Tiles (Terrarium), SRTM/GMTED 合成, 无需密钥',
            'min': min(grid), 'max': max(grid), 'file': os.path.basename(fp)}
    with io.open(os.path.join(OUT, '%s_30m.json' % a.name), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print('已写入 %s  %.1f MB  %d×%d  高程 %d–%d m  ~%.1f m/px'
          % (fp, os.path.getsize(fp) / 1048576.0, W, H, meta['min'], meta['max'], meta['approx_m_per_px']))


if __name__ == '__main__':
    main()
