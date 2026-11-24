# -*- coding: utf-8 -*-
"""
数据快照备份：把 PostgreSQL 里的全部表 / 视图导出为压缩 CSV，落到仓库内，并可一键提交推送。

为什么需要它
  云库负责"三人实时共享、可 SQL 查询"，Git 负责"代码版本"。
  但论文投稿要求数据可追溯，云库的当前状态不等于历史记录。
  于是每周跑一次本脚本：库 -> CSV 快照 -> Git 历史，两条通道各司其职。

体积控制
  3.7 万行纯文本压缩后通常只有 1-3 MB，不会把仓库撑大。
  历史快照默认只保留最近 --keep 份，更早的会自动清理（旧版本仍留在 Git 历史里）。

用法
  python tools/backup_to_repo.py                  # 只导出，不提交
  python tools/backup_to_repo.py --push           # 导出 + git commit + git push
  python tools/backup_to_repo.py --keep 4         # 只保留最近 4 份快照
  python tools/backup_to_repo.py --dsn "host=127.0.0.1 port=5432 dbname=jinsha user=postgres"

连接优先级
  --dsn 参数 > 环境变量 JINSHA_DSN > 本机 127.0.0.1:5432/jinsha
  与 tools/pg_sync.py 保持一致，不会静默把云库操作打到本地库上。
"""
import argparse
import datetime
import gzip
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAP_ROOT = os.path.join(ROOT, 'data', 'sql', 'snapshots')

SKIP_SCHEMAS = ('pg_catalog', 'information_schema', 'pg_toast')


def _host_of(dsn):
    for part in dsn.split():
        if part.startswith('host='):
            return part[5:]
    return 'local'


class Db(object):
    def __init__(self, dsn=None, container='jinsha-pg', db='jinsha', user='postgres'):
        self.mode, self.conn = None, None
        self.container, self.db, self.user = container, db, user
        dsn = dsn or os.environ.get('JINSHA_DSN')
        if dsn:
            try:
                import psycopg2
            except Exception:
                raise SystemExit('已指定 DSN 但缺少 psycopg2，请先执行: pip install psycopg2-binary')
            try:
                self.conn = psycopg2.connect(dsn)
                self.mode = 'psycopg2'
                self.label = _host_of(dsn)
                print('[DB] 已连接：%s' % self.label)
                return
            except Exception as e:
                raise SystemExit('[DB] 连接失败，请检查 JINSHA_DSN：%s' % e)

        try:
            import psycopg2
            self.conn = psycopg2.connect('host=127.0.0.1 port=5432 dbname=%s user=%s' % (db, user))
            self.mode = 'psycopg2'
            self.label = 'localhost:%s' % db
            print('[DB] 已连接本地：%s' % self.label)
            return
        except Exception:
            pass

        if self._ok(['psql', '--version']):
            self.mode, self.label = 'psql', 'localhost:%s (psql)' % db
        elif self._ok(['docker', 'exec', container, 'psql', '--version']):
            self.mode, self.label = 'docker', '%s (docker)' % container
        else:
            raise SystemExit('[DB] 找不到可用连接通道：装 psycopg2-binary，或确保 psql / docker 容器可用')

    @staticmethod
    def _ok(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, timeout=60).returncode == 0
        except Exception:
            return False

    def _psql_cmd(self):
        if self.mode == 'psql':
            return ['psql', '-d', self.db, '-U', self.user]
        return ['docker', 'exec', '-i', self.container, 'psql', '-U', self.user, '-d', self.db]

    def query(self, sql):
        if self.mode == 'psycopg2':
            with self.conn.cursor() as cur:
                cur.execute(sql)
                return cur.fetchall()
        r = subprocess.run(self._psql_cmd() + ['-AtF', '\t', '-c', sql],
                           capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300)
        if r.returncode != 0:
            raise SystemExit('[DB] 查询失败：%s' % (r.stderr or '')[:300])
        return [tuple(l.split('\t')) for l in (r.stdout or '').strip().splitlines() if l]

    def dump_csv(self, qualified, path):
        """把一张表/视图导成 gz 压缩 CSV（带表头）。"""
        sql = 'COPY (SELECT * FROM %s) TO STDOUT WITH (FORMAT csv, HEADER true)' % qualified
        if self.mode == 'psycopg2':
            with gzip.open(path, 'wt', encoding='utf-8', newline='') as fh:
                with self.conn.cursor() as cur:
                    cur.copy_expert(sql, fh)
            return
        r = subprocess.run(self._psql_cmd() + ['-c', sql], capture_output=True, timeout=600)
        if r.returncode != 0:
            raise SystemExit('[DB] 导出失败 %s：%s' % (qualified, (r.stderr or b'').decode('utf-8', 'replace')[:300]))
        with gzip.open(path, 'wb') as fh:
            fh.write(r.stdout)


def list_objects(db):
    rows = db.query("""
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name
    """)
    out = []
    for schema, name, ttype in rows:
        if schema in SKIP_SCHEMAS:
            continue
        out.append((schema, name, 'view' if 'VIEW' in (ttype or '').upper() else 'table'))
    return out


def prune(snap_root, keep):
    if keep <= 0:
        return []
    dirs = sorted([d for d in os.listdir(snap_root)
                   if os.path.isdir(os.path.join(snap_root, d))])
    stale = dirs[:-keep] if len(dirs) > keep else []
    for d in stale:
        shutil.rmtree(os.path.join(snap_root, d), ignore_errors=True)
    return stale


def git_publish(snap_dir, total_rows, n_obj):
    rel = os.path.relpath(snap_dir, ROOT).replace('\\', '/')
    msg = 'data: 数据快照 %s（%d 个对象 / %d 行）' % (os.path.basename(snap_dir), n_obj, total_rows)
    steps = [
        ['git', 'add', '-A', rel],
        ['git', 'commit', '-m', msg],
        ['git', 'push'],
    ]
    for cmd in steps:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
        if r.returncode != 0:
            out = (r.stdout or '') + (r.stderr or '')
            if 'nothing to commit' in out or '无文件要提交' in out:
                print('[GIT] 与上次快照一致，无需提交')
                return True
            print('[GIT] %s 失败：\n%s' % (' '.join(cmd[:2]), out.strip()[:800]))
            return False
        print('[GIT] %s 完成' % ' '.join(cmd[:2]))
    return True


def main():
    ap = argparse.ArgumentParser(description='把数据库全部表导出为压缩 CSV 快照，可自动提交到 Git')
    ap.add_argument('--dsn', help='数据库连接串，默认读环境变量 JINSHA_DSN')
    ap.add_argument('--push', action='store_true', help='导出后自动 git add/commit/push')
    ap.add_argument('--keep', type=int, default=8, help='本地保留最近几份快照，默认 8，0 表示不清理')
    ap.add_argument('--container', default='jinsha-pg', help='回退用的 docker 容器名')
    args = ap.parse_args()

    db = Db(dsn=args.dsn, container=args.container)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M')
    snap_dir = os.path.join(SNAP_ROOT, stamp)
    if os.path.isdir(snap_dir):
        raise SystemExit('[!] 快照目录已存在（同一分钟跑两次？）：%s' % snap_dir)
    os.makedirs(snap_dir)

    objects = list_objects(db)
    if not objects:
        raise SystemExit('[!] 库里没有任何表，检查连接是否指错了数据库')

    manifest = {
        'generated_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'source': db.label,
        'objects': [],
        'total_rows': 0,
    }
    print('[..] 共 %d 个对象，开始导出' % len(objects))
    for schema, name, kind in objects:
        qualified = '"%s"."%s"' % (schema, name)
        fname = '%s.%s.csv.gz' % (schema, name)
        path = os.path.join(snap_dir, fname)
        db.dump_csv(qualified, path)
        try:
            cnt = db.query('SELECT count(*) FROM %s' % qualified)[0][0]
            cnt = int(cnt)
        except Exception:
            cnt = -1
        manifest['objects'].append({
            'schema': schema, 'name': name, 'type': kind,
            'rows': cnt, 'file': fname, 'bytes': os.path.getsize(path),
        })
        manifest['total_rows'] += max(cnt, 0)
        print('  %-28s %8s 行  %7.1f KB' % ('%s.%s' % (schema, name), cnt, os.path.getsize(path) / 1024.0))

    mpath = os.path.join(snap_dir, 'MANIFEST.json')
    with open(mpath, 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)

    total_mb = sum(o['bytes'] for o in manifest['objects']) / 1048576.0
    print('\n[OK] 快照 %s：%d 个对象 / %d 行 / %.2f MB'
          % (stamp, len(manifest['objects']), manifest['total_rows'], total_mb))

    stale = prune(SNAP_ROOT, args.keep)
    for d in stale:
        print('[..] 清理旧快照 %s' % d)

    if args.push:
        ok = git_publish(snap_dir, manifest['total_rows'], len(manifest['objects']))
        if not ok:
            sys.exit(1)
    else:
        print('[i] 未提交。检查无误后运行：git add -A && git commit -m "数据快照" && git push')
        print('    ［或直接加 --push 让脚本代劳］')


if __name__ == '__main__':
    main()
