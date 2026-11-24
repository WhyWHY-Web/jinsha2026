#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把本地 XYZ 瓦片拼成一张"等经纬度"全域影像纹理。

为什么需要它：
  三维地形用的是等经纬度 UV（u=经度、v=纬度），而 XYZ 瓦片是 Web Mercator。
  直接把瓦片贴上去会在南北方向被拉伸，所以这里逐块做墨卡托 → 等经纬度的重采样。

用法：
  python tools/make_sat_mosaic.py --z 12 --size 4096
输出：
  web/assets/img/satellite-3d-hd.jpg
"""
import argparse
import math
import os
import sys
import time

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TILES = os.path.join(ROOT, 'data', 'tiles')
OUT = os.path.join(ROOT, 'web', 'assets', 'img', 'satellite-3d-hd.jpg')

# 与前端 LON_MIN/LON_MAX/LAT_MIN/LAT_MAX 完全一致
LON0, LON1 = 97.6, 105.4
LAT0, LAT1 = 25.9, 32.5
TS = 256


def lon_of(x, z):
    return x / float(1 << z) * 360.0 - 180.0


def lat_of(y, z):
    n = math.pi - 2.0 * math.pi * y / float(1 << z)
    return math.degrees(math.atan(math.sinh(n)))


def tile_range(z):
    n = 1 << z

    def tx(lon):
        return int((lon + 180.0) / 360.0 * n)

    def ty(lat):
        r = math.radians(lat)
        return int((1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n)

    return tx(LON0), tx(LON1), ty(LAT1), ty(LAT0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--z', type=int, default=12, help='瓦片层级（默认 12）')
    ap.add_argument('--size', type=int, default=4096, help='输出边长（默认 4096）')
    ap.add_argument('--quality', type=int, default=88)
    a = ap.parse_args()

    z = a.z
    W = H = a.size
    x0, x1, y0, y1 = tile_range(z)
    nx, ny = x1 - x0 + 1, y1 - y0 + 1
    print('层级 z%d · 瓦片范围 x %d–%d, y %d–%d （%d×%d = %d 块）'
          % (z, x0, x1, y0, y1, nx, ny, nx * ny))

    img = Image.new('RGB', (W, H), (12, 22, 28))
    t0 = time.time()
    done = miss = 0
    for x in range(x0, x1 + 1):
        for y in range(y0, y1 + 1):
            fp = os.path.join(TILES, str(z), str(x), '%d.jpg' % y)
            if not os.path.isfile(fp):
                miss += 1
                continue
            t_lon0, t_lon1 = lon_of(x, z), lon_of(x + 1, z)
            t_lat1, t_lat0 = lat_of(y, z), lat_of(y + 1, z)
            # 与目标范围的交集
            ix0, ix1 = max(t_lon0, LON0), min(t_lon1, LON1)
            iy0, iy1 = max(t_lat0, LAT0), min(t_lat1, LAT1)
            if ix1 <= ix0 or iy1 <= iy0:
                continue
            # 目标像素矩形
            px0 = (ix0 - LON0) / (LON1 - LON0) * W
            px1 = (ix1 - LON0) / (LON1 - LON0) * W
            py0 = (LAT1 - iy1) / (LAT1 - LAT0) * H
            py1 = (LAT1 - iy0) / (LAT1 - LAT0) * H
            # 多铺 1 px：瓦片按整像素取整会留下 1px 缝，重叠可彻底消掉接缝
            dw, dh = max(1, int(round(px1 - px0)) + 1), max(1, int(round(py1 - py0)) + 1)
            # 瓦片内裁剪
            cx0 = (ix0 - t_lon0) / (t_lon1 - t_lon0) * TS
            cx1 = (ix1 - t_lon0) / (t_lon1 - t_lon0) * TS
            cy0 = (t_lat1 - iy1) / (t_lat1 - t_lat0) * TS
            cy1 = (t_lat1 - iy0) / (t_lat1 - t_lat0) * TS
            try:
                tile = Image.open(fp).convert('RGB')
            except Exception:
                miss += 1
                continue
            crop = tile.crop((int(cx0), int(cy0), max(int(cx0) + 1, int(cx1)), max(int(cy0) + 1, int(cy1))))
            if crop.size != (dw, dh):
                crop = crop.resize((dw, dh), Image.LANCZOS)
            img.paste(crop, (int(round(px0)), int(round(py0))))
            done += 1
        if (x - x0) % 10 == 0:
            print('  …%d/%d 列  已贴 %d 块  缺 %d   %.0fs'
                  % (x - x0 + 1, nx, done, miss, time.time() - t0), flush=True)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, 'JPEG', quality=a.quality, optimize=True, progressive=True)
    print('完成：%d 块，缺 %d 块，%.1f s → %s（%.1f MB）'
          % (done, miss, time.time() - t0, OUT, os.path.getsize(OUT) / 1048576.0))


if __name__ == '__main__':
    main()
