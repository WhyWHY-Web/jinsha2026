# -*- coding: utf-8 -*-
"""把云库所有表导出为 CSV（含中文表头），用于销毁云库前把数据落到 Git
用法：
  set JINSHA_DSN=postgresql://Jinsha_2026:密码@主机:端口/postgres
  python tools/export_cloud_to_csv.py
产物：data/pg_export/<表名>.csv + manifest.json（表清单与行数）
"""
import os, sys, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'pg_export')
DSN = os.environ.get('JINSHA_DSN') or \
    'postgresql://Jinsha_2026:Wanghaoyu666.@cd-postgres-g3503ark.sql.tencentcdb.com:29346/postgres'

def main():
    import psycopg2
    conn = psycopg2.connect(DSN)
    cur = conn.cursor()
    cur.execute("""select table_name from information_schema.tables
                   where table_schema='public' and table_type='BASE TABLE' order by 1""")
    tables = [r[0] for r in cur.fetchall()]
    # 腾讯云自动创建的拨测探针表：非业务数据，且 DROP 后会被服务自动重建，导出时排除
    tables = [t for t in tables if not t.startswith('tencentdb_tbl_dial_test_')]
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for t in tables:
        q = '"%s"' % t.replace('"', '""')
        cur.execute('select count(*) from %s' % q)
        n = cur.fetchone()[0]
        path = os.path.join(OUT, t + '.csv')
        with open(path, 'w', encoding='utf-8-sig', newline='') as fp:
            cur.copy_expert('COPY %s TO STDOUT WITH CSV HEADER' % q, fp)
        manifest[t] = n
        print('%-14s %8d 行 -> %s' % (t, n, os.path.basename(path)))
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fp:
        json.dump(manifest, fp, ensure_ascii=False, indent=2)
    print('共 %d 张表，%d 行，导出目录: %s' % (len(tables), sum(manifest.values()), OUT))
    conn.close()

if __name__ == '__main__':
    main()
