# -*- coding: utf-8 -*-
"""把 data/sql/snapshots/<时间戳>/ 里的 csv.gz 快照离线转换为 data/*.json。

背景：云 PostgreSQL 已销毁，产品运行时读取 data/*.json；本脚本从压缩快照（唯一
全量落地）离线还原分析表，供 /api/data/<name> 读取。不再依赖 pg_util（云库已不可达）。

导出对象（12 张分析表）：
  金沙江气候月值 / 年值 / 趋势、格点面平均月值、流域年值、交叉验证
  金沙江水文月值 / 年值
  生态服务、站点气候特征

跳过（已被 data/gee/*.json 或运行时实时计算覆盖，避免重复）：
  遥感年值/月值/趋势/静态值/概览 → data/gee/*.json + /api/rs/*
  生态评估、站点植被 → server.py eco_item() 实时计算
  气候年值/月值/趋势、站点实测（历史遗留 20 站尺度）→ 已被金沙江气候* 取代

用法：python tools/snapshot_to_json.py [快照目录]
"""
import csv
import gzip
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP = os.path.join(ROOT, 'data', 'sql', 'snapshots')


# 表名 -> 输出相对路径（相对 ROOT）
SPECS = [
    ('金沙江气候月值', 'data/climate_monthly.json'),
    ('金沙江气候年值', 'data/climate_annual.json'),
    ('金沙江气候趋势', 'data/climate_trend.json'),
    ('金沙江格点面平均月值', 'data/basin_monthly.json'),
    ('金沙江流域年值', 'data/basin_annual.json'),
    ('金沙江交叉验证', 'data/climate_crosscheck.json'),
    ('金沙江水文月值', 'data/hydro_monthly.json'),
    ('金沙江水文年值', 'data/hydro_annual.json'),
    ('生态服务', 'data/eco_services.json'),
    ('站点气候特征', 'data/station_climate.json'),
]


def coerce(v):
    """CSV 单元格 -> 轻量类型：空串保留，可解析为数字则转 int/float，否则字符串。"""
    if v is None:
        return v
    s = v.strip()
    if s == '':
        return ''
    try:
        if '.' not in s and 'e' not in s.lower():
            return int(s)
        return float(s)
    except ValueError:
        return s


def latest_snapshot():
    if not os.path.isdir(SNAP):
        return None
    dirs = [d for d in os.listdir(SNAP) if os.path.isdir(os.path.join(SNAP, d))]
    dirs.sort(reverse=True)
    return os.path.join(SNAP, dirs[0]) if dirs else None


def load_manifest(snap):
    mp = os.path.join(snap, 'MANIFEST.json')
    if not os.path.isfile(mp):
        return {}
    with open(mp, encoding='utf-8') as f:
        data = json.load(f)
    return {o['name']: o for o in data.get('objects', [])}


def convert(snap):
    manifest = load_manifest(snap)
    ok = fail = 0
    rows = []
    for name, rel in SPECS:
        fp = os.path.join(snap, 'public.%s.csv.gz' % name)
        if not os.path.isfile(fp):
            print('[!] 缺失快照 %s' % fp)
            fail += 1
            continue
        with gzip.open(fp, 'rt', encoding='utf-8-sig', newline='') as f:
            reader = csv.DictReader(f)
            data = [{k: coerce(v) for k, v in row.items()} for row in reader]
        out = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        expect = (manifest.get(name) or {}).get('rows')
        flag = 'OK' if (expect is None or expect == len(data)) else 'MISMATCH'
        print('%-18s %6d 行 (期望 %s) %s -> %s' % (name, len(data), expect, flag, rel))
        if flag == 'MISMATCH':
            fail += 1
        else:
            ok += 1
        rows.append((name, len(data), expect))
    return ok, fail, rows


def main():
    snap = sys.argv[1] if len(sys.argv) > 1 else latest_snapshot()
    if not snap:
        print('未找到快照目录：%s' % SNAP)
        return 2
    print('快照目录：%s' % snap)
    ok, fail, _ = convert(snap)
    print('\n完成：%d 表导出成功，%d 表失败/条数不符' % (ok, fail))
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
