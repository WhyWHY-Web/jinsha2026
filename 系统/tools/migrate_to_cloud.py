# -*- coding: utf-8 -*-
"""本地 jinsha 库 -> 云库 一键迁移（建表 + COPY 灌数据 + 行数核对）
用法:
  set JINSHA_DSN=postgresql://Jinsha_2026:密码@主机:端口/postgres
  python tools/migrate_to_cloud.py
"""
import os
import sys
import psycopg2

LOCAL = dict(host='127.0.0.1', port=5432, user='postgres',
             password='jinsha2026', dbname='jinsha')
REMOTE_DSN = os.environ.get('JINSHA_DSN')

TYPE_MAP = {  # 本地->云端类型基本一致，无需映射，直接用
}

def q(name):
    return '"%s"' % name.replace('"', '""')

def local_tables(cur):
    cur.execute("""select table_name from information_schema.tables
                   where table_schema='public' and table_type='BASE TABLE' order by 1""")
    return [r[0] for r in cur.fetchall()]

def create_sql(cur, table):
    # 列定义
    cur.execute("""select column_name, data_type, character_maximum_length,
                          numeric_precision, numeric_scale, is_nullable, column_default
                   from information_schema.columns
                   where table_schema='public' and table_name=%s
                   order by ordinal_position""", (table,))
    cols = []
    seqs = []
    for name, dt, cml, np, ns, nullable, dflt in cur.fetchall():
        t = dt
        if dt == 'character varying' and cml:
            t = 'varchar(%d)' % cml
        elif dt == 'numeric' and np:
            t = 'numeric(%d,%d)' % (np, ns)
        line = '%s %s' % (q(name), t)
        if dflt and 'nextval' in str(dflt):
            # serial 化：建表时忽略默认值，之后补 sequence
            seqs.append((name, dflt))
        else:
            if dflt:
                line += ' DEFAULT %s' % dflt
        if nullable == 'NO':
            line += ' NOT NULL'
        cols.append(line)
    # 主键
    cur.execute("""select a.attname from pg_index i
                   join pg_class c on c.oid=i.indrelid
                   join pg_attribute a on a.attrelid=c.oid and a.attnum = any(i.indkey)
                   join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relname=%s and i.indisprimary""", (table,))
    pk = [r[0] for r in cur.fetchall()]
    if pk:
        cols.append('PRIMARY KEY (%s)' % ', '.join(q(c) for c in pk))
    return 'CREATE TABLE IF NOT EXISTS %s (\n  %s\n)' % (q(table), ',\n  '.join(cols)), seqs

def main():
    remote_dsn = REMOTE_DSN
    if not remote_dsn:
        sys.exit('请设置环境变量 JINSHA_DSN，例如 postgresql://Jinsha_2026:密码@主机:端口/postgres')
    loc = psycopg2.connect(**LOCAL)
    rem = psycopg2.connect(remote_dsn)
    lc, rc = loc.cursor(), rem.cursor()
    tables = local_tables(lc)
    print('待迁移表: %d 张' % len(tables))
    report = []
    for t in tables:
        sql, seqs = create_sql(lc, t)
        try:
            rc.execute(sql)
        except Exception as e:
            rem.rollback()
            print('[跳过建表] %s: %s' % (t, e))
            continue
        # 清空云端旧数据，保证可重复执行
        rc.execute('TRUNCATE TABLE %s' % q(t))
        # 结构列取交集，防止云端已有旧结构列不一致
        lc.execute("""select column_name from information_schema.columns
                      where table_schema='public' and table_name=%s order by ordinal_position""", (t,))
        cols_l = [r[0] for r in lc.fetchall()]
        rc.execute("""select column_name from information_schema.columns
                      where table_schema='public' and table_name=%s order by ordinal_position""", (t,))
        cols_r = [r[0] for r in rc.fetchall()]
        cols = [c for c in cols_l if c in cols_r]
        collist = ', '.join(q(c) for c in cols)
        # 跨连接 COPY：先 TO STDOUT 进内存缓冲，再 FROM STDIN 灌云端
        import io
        buf = io.BytesIO()
        lc.copy_expert('COPY (SELECT %s FROM %s) TO STDOUT' % (collist, q(t)), buf)
        buf.seek(0)
        rc.copy_expert('COPY %s (%s) FROM STDIN' % (q(t), collist), buf)
        rem.commit()
        rc.execute('select count(*) from %s' % q(t))
        n_r = rc.fetchone()[0]
        lc.execute('select count(*) from %s' % q(t))
        n_l = lc.fetchone()[0]
        ok = 'OK' if n_r == n_l else '!!!行数不一致'
        report.append((t, n_l, n_r, ok))
        print('%-12s 本地 %6d -> 云端 %6d  %s' % (t, n_l, n_r, ok))
    rem.commit()
    print('\n===== 汇总 =====')
    bad = [r for r in report if r[3] != 'OK']
    print('迁移完成 %d 张，异常 %d 张' % (len(report) - len(bad), len(bad)))
    loc.close(); rem.close()

if __name__ == '__main__':
    main()
