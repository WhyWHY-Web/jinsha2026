# -*- coding: utf-8 -*-
"""把 data/rsei/rsei_all.json（或单个 rsei_YYYY.json）写入云库 rsei_annual 表
用法：
  python tools/rsei_to_pg.py                # 读 rsei_all.json 全量 upsert
  python tools/rsei_to_pg.py --file data/rsei/rsei_2020.json
依赖：miniconda python + psycopg2-binary；云库 DSN 走 JINSHA_DSN 环境变量
"""
import json, os, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg_util  # noqa: E402
DSN = pg_util.dsn()

DDL = """
CREATE TABLE IF NOT EXISTS rsei_annual (
  "年份" int PRIMARY KEY,
  "传感器" text,
  "影像数" int,
  "RSEI均值" double precision,
  "NDVI均值" double precision,
  "WET均值" double precision,
  "NDSI均值" double precision,
  "LST均值" double precision,
  "总面积km2" double precision,
  "差占比" double precision,
  "较差占比" double precision,
  "中等占比" double precision,
  "良占比" double precision,
  "优占比" double precision,
  "PC1_NDVI" double precision,
  "PC1_WET" double precision,
  "PC1_NDSI" double precision,
  "PC1_LST" double precision,
  "采集时间" timestamptz default now()
);
"""

UPSERT = """
INSERT INTO rsei_annual VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,now())
ON CONFLICT ("年份") DO UPDATE SET
  "传感器"=EXCLUDED."传感器","影像数"=EXCLUDED."影像数",
  "RSEI均值"=EXCLUDED."RSEI均值","NDVI均值"=EXCLUDED."NDVI均值",
  "WET均值"=EXCLUDED."WET均值","NDSI均值"=EXCLUDED."NDSI均值",
  "LST均值"=EXCLUDED."LST均值","总面积km2"=EXCLUDED."总面积km2",
  "差占比"=EXCLUDED."差占比","较差占比"=EXCLUDED."较差占比",
  "中等占比"=EXCLUDED."中等占比","良占比"=EXCLUDED."良占比",
  "优占比"=EXCLUDED."优占比","PC1_NDVI"=EXCLUDED."PC1_NDVI",
  "PC1_WET"=EXCLUDED."PC1_WET","PC1_NDSI"=EXCLUDED."PC1_NDSI",
  "PC1_LST"=EXCLUDED."PC1_LST","采集时间"=now();
"""

def load_rows(path):
    with open(path, encoding='utf-8') as fp:
        data = json.load(fp)
    if isinstance(data, list):
        return [d for d in data if 'error' not in d]
    return [data]

def main():
    import psycopg2
    if len(sys.argv) > 2 and sys.argv[1] == '--file':
        path = sys.argv[2]
    else:
        path = os.path.join(ROOT, 'data', 'rsei', 'rsei_all.json')
    rows = load_rows(path)
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()
    cur.execute(DDL)
    n = 0
    for r in rows:
        pc = r['pc1_loadings']
        cur.execute(UPSERT, (
            r['year'], r['sensor'], r['n_scenes'],
            r['rsei_mean'], r['ndvi_mean'], r['wet_mean'], r['ndsi_mean'], r['lst_mean'],
            r['total_area_km2'],
            r['class_0_pct'], r['class_1_pct'], r['class_2_pct'], r['class_3_pct'], r['class_4_pct'],
            pc['ndvi'], pc['wet'], pc['ndsi'], pc['lst'],
        ))
        n += 1
    conn.commit()
    cur.execute('select count(*) from rsei_annual')
    total = cur.fetchone()[0]
    print('已写入 %d 期，rsei_annual 表当前共 %d 行' % (n, total))
    conn.close()

if __name__ == '__main__':
    main()
