# -*- coding: utf-8 -*-
"""共享 PostgreSQL 工具：连接（JINSHA_DSN 优先，回退云库）+ upsert + 时间戳。

供土地利用/夜间灯光/人口/空间自相关/质检脚本复用，避免重复代码。
"""
import os
import datetime
import psycopg2

# 云库兜底连接串（密码结尾有个英文句点）
CLOUD_DSN = 'postgresql://Jinsha_2026:Wanghaoyu666.@cd-postgres-g3503ark.sql.tencentcdb.com:29346/postgres'


def dsn():
    return os.environ.get('JINSHA_DSN') or CLOUD_DSN


def get_conn(autocommit=False):
    conn = psycopg2.connect(dsn())
    conn.autocommit = autocommit
    return conn


def now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def upsert(table, columns, rows, conflict_cols=None, conn=None):
    """批量 upsert：按 conflict_cols 冲突时更新其余列。

    table/columns 支持中文表名、中文列名（自动加双引号）。
    rows 为 list[tuple]，长度与 columns 一致。
    """
    own = conn is None
    if own:
        conn = get_conn()
    cols = list(columns)
    q = '"%s"' % table.replace('"', '""')
    colsql = ', '.join('"%s"' % c.replace('"', '""') for c in cols)
    marks = ', '.join(['%s'] * len(cols))
    sql = 'INSERT INTO %s (%s) VALUES (%s)' % (q, colsql, marks)
    if conflict_cols:
        ccols = ', '.join('"%s"' % c.replace('"', '""') for c in conflict_cols)
        upd = ', '.join('"%s"=EXCLUDED."%s"' % (c.replace('"', '""'), c.replace('"', '""'))
                        for c in cols if c not in conflict_cols)
        sql += (' ON CONFLICT (%s) DO UPDATE SET %s' % (ccols, upd)) if upd \
            else (' ON CONFLICT (%s) DO NOTHING' % ccols)
    with conn.cursor() as cur:
        cur.executemany(sql, rows)
        conn.commit()
    if own:
        conn.close()


def query(sql, conn=None):
    own = conn is None
    if own:
        conn = get_conn()
    with conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
    if own:
        conn.close()
    return rows
