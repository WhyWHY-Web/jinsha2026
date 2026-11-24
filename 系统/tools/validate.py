# -*- coding: utf-8 -*-
"""多源气象产品交叉验证（无需联网，读库内两份独立产品）

目的：证明"数据接入没有接错"，并量化两套独立产品之间的偏差来源。
  · 气温：NASA POWER（MERRA-2，已按 6.5 ℃/km 订正到站点高程）
          vs ERA5-Land（格点原始值）
  · 降水：NASA POWER vs GPM IMERG（卫星）

关键方法点（也是本项目最容易做错、已修正的一处）：
  ERA5-Land 的"格点高程"应当用 **0.1° 格元内的平均地形**，而不是格元中心点的高程。
  用中心点会把地形起伏当成格点高程误差，订正时反而引入噪声：
      中心点取值 → 订正后 r=0.736  RMSE=4.41  bias=-2.43
      格元均值   → 订正后 r=0.934  RMSE=2.36  bias=-1.50
  这不是调参，是物理量定义问题。

产出：data/validate.json（后端 /api/validate 直接读它）

用法：
    python tools/validate.py
    python tools/validate.py --verbose
"""
from __future__ import print_function
import argparse
import io
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import server as S  # noqa: E402

DATA = os.path.join(ROOT, 'data')
LAPSE = 0.0065          # ℃/m，标准递减率
CELL = 0.1              # ERA5-Land 格元边长（度）
SUB = 5                 # 格元内 5×5 子样


def cell_mean_elev(lon, lat, n=SUB):
    """0.1° 格元内 n×n 子样均值高程，近似 ERA5-Land 的格元有效地形。"""
    c_lon = round(lon / CELL) * CELL
    c_lat = round(lat / CELL) * CELL
    step = CELL / (n - 1)
    vals = []
    for i in range(n):
        for j in range(n):
            vals.append(S.dem_at(c_lon - CELL / 2 + step * i,
                                 c_lat - CELL / 2 + step * j))
    return sum(vals) / len(vals)


def stats(a, b):
    """返回 r / RMSE / bias / n。b 相对 a 的偏差（b−a）。"""
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    r = cov / math.sqrt(va * vb) if va and vb else 0.0
    rmse = math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(n)) / n)
    bias = sum(b[i] - a[i] for i in range(n)) / n
    return {'r': round(r, 3), 'rmse': round(rmse, 2), 'bias': round(bias, 2), 'n': n}


def annual_gee(series, name, key, how):
    """把 GEE 月值聚成站-年值：temp 取均值，precip 取累计。要求年内 ≥10 个月。"""
    by = {}
    for ym, v, q in (series.get(key, {}).get(name) or []):
        if v is None:
            continue
        y = int(ym[:4])
        if y < 2015:
            continue
        by.setdefault(y, []).append(v)
    out = {}
    for y, vals in by.items():
        if len(vals) < 10:
            continue
        out[y] = sum(vals) / len(vals) if how == 'mean' else sum(vals)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    clim = json.load(io.open(os.path.join(DATA, 'climate.json'), encoding='utf-8'))['stations']
    rs = json.load(io.open(os.path.join(DATA, 'gee', 'series.json'), encoding='utf-8'))
    stmap = {x['name']: x for x in S.all_stations()}

    out = {}

    # ---------- 气温 ----------
    A, B, C, dz = [], [], [], []
    for nm, st in clim.items():
        s = stmap.get(nm)
        if not s:
            continue
        site_elev = S.eff_val(s, 'elev')
        grid_elev = cell_mean_elev(s['lon'], s['lat'])
        dz.append(site_elev - grid_elev)
        pw = {r[0]: r[1] for r in st['years']}
        for y, v in annual_gee(rs, nm, 'temp', 'mean').items():
            if y not in pw:
                continue
            A.append(pw[y])
            B.append(v)
            C.append(v - LAPSE * (site_elev - grid_elev))   # 订正到站点高程
    r0 = stats(A, B)
    r1 = stats(A, C)
    out['temp'] = {
        'a': 'NASA POWER（MERRA-2，已订正）', 'b': 'ERA5-Land（格点原始值）',
        'r': r1['r'], 'rmse': r1['rmse'], 'bias': r1['bias'], 'n': r1['n'],
        'raw': {'r': r0['r'], 'rmse': r0['rmse'], 'bias': r0['bias']},
        'correction': '按 6.5 ℃/km 从 0.1° 格元平均地形订正到站点高程',
        'dz_mean': round(sum(dz) / len(dz)) if dz else None,
        'unit': '℃',
        'note': '订正前存在系统性冷偏差，主因是格元地形与站点高程差异；订正后 r 与 RMSE 同时改善',
    }

    # ---------- 降水 ----------
    A, B = [], []
    for nm, st in clim.items():
        s = stmap.get(nm)
        if not s:
            continue
        pw = {r[0]: r[2] for r in st['years']}
        for y, v in annual_gee(rs, nm, 'precip', 'sum').items():
            if y not in pw:
                continue
            A.append(pw[y])
            B.append(v)
    rp = stats(A, B)
    out['precip'] = {
        'a': 'NASA POWER（MERRA-2）', 'b': 'GPM IMERG（卫星）',
        'r': rp['r'], 'rmse': rp['rmse'], 'bias': rp['bias'], 'n': rp['n'],
        'unit': 'mm',
        'note': 'IMERG 在横断山区系统性高估（像元 0.1° 把谷地水汽摊成面雨量），属文献已知特征；'
                '降水主用 POWER，IMERG 仅作交叉参考',
    }

    fp = os.path.join(DATA, 'validate.json')
    json.dump(out, io.open(fp, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

    if a.verbose:
        print('站点—格元高程差 均值 %s m（n=%d）' % (out['temp']['dz_mean'], len(dz)))
        print('气温  原始 r=%.3f RMSE=%.2f bias=%+.2f' % (r0['r'], r0['rmse'], r0['bias']))
        print('气温  订正 r=%.3f RMSE=%.2f bias=%+.2f  n=%d' % (r1['r'], r1['rmse'], r1['bias'], r1['n']))
        print('降水       r=%.3f RMSE=%.1f bias=%+.1f  n=%d' % (rp['r'], rp['rmse'], rp['bias'], rp['n']))
    print('已写入 %s' % fp)


if __name__ == '__main__':
    main()
