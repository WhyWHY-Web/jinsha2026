# -*- coding: utf-8 -*-
"""把云库的分析结果表导出为 data/*.json，供前端 /api/data/<name> 读取。

导出对象：
  rsei_annual -> data/rsei/rsei_all.json（已是 8 期，直接复用现有文件）
  lulc        -> data/lulc/lulc.json
  nightlight  -> data/nightlight/nightlight.json
  population  -> data/population/population.json
  moran_lisa  -> data/rsei/moran_lisa.json

用法：python tools/export_json.py
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import pg_util  # noqa: E402

# 表名 -> (输出相对路径, 键列)
SPECS = {
    'lulc': ('data/lulc/lulc.json', None),
    'nightlight': ('data/nightlight/nightlight.json', None),
    'population': ('data/population/population.json', None),
    'moran_lisa': ('data/rsei/moran_lisa.json', None),
}


def dump_table(name, path):
    conn = pg_util.get_conn()
    cur = conn.cursor()
    cur.execute('SELECT * FROM "%s" ORDER BY 1' % name)
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    conn.close()
    data = [dict(zip(cols, r)) for r in rows]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as fp:
        json.dump(data, fp, ensure_ascii=False, indent=2, default=str)
    print('%-14s %6d 行 -> %s' % (name, len(data), path))


def main():
    for name, (rel, _) in SPECS.items():
        try:
            dump_table(name, os.path.join(ROOT, rel))
        except Exception as e:
            print('[!] %s 导出失败: %s' % (name, str(e)[:120]))


if __name__ == '__main__':
    main()
