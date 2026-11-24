# -*- coding: utf-8 -*-
"""
应用快照入库：把运行时 JSON 落到 PostgreSQL 的 app schema，形成"可 SQL 查询的真数据"。

为什么这么设计
  public schema 是人工维护的原始台账（站点/气候/生态服务，口径已定稿）；
  app  schema 是每次构建由脚本刷新的**应用快照**，表结构与前端一一对应。
  两者分开，既不动生产数据，又能让"数据到底在不在库里"变成可验证的事实：
      select count(*) from app."生态指标";
  写库通道沿用本项目已验证的三级降级：psycopg2 → 本机 psql → docker exec jinsha-pg psql。

用法
  python tools/pg_sync.py                # 同步并打印各表行数
  python tools/pg_sync.py --dsn "host=... dbname=jinsha user=postgres"
产物
  PostgreSQL app.*  +  data/pg_status.json（供 /api/db/status 前端展示）
"""
import argparse, json, math, os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
STATUS = os.path.join(DATA, 'pg_status.json')


def load(name, default=None):
    fp = os.path.join(DATA, name)
    if not os.path.isfile(fp):
        return default
    try:
        return json.load(open(fp, encoding='utf-8'))
    except Exception:
        return default


class Pg:
    def __init__(self, dsn=None, container='jinsha-pg', db='jinsha', user='postgres'):
        self.mode, self.conn = None, None
        self.container, self.db, self.user = container, db, user
        dsn = dsn or os.environ.get('JINSHA_DSN')
        if dsn:
            # 指定了远程/云库 DSN：只走 psycopg2，失败要报错，绝不静默降级到本地库
            try:
                import psycopg2
            except Exception:
                raise SystemExit('JINSHA_DSN 已配置但缺少 psycopg2，请先执行: pip install psycopg2-binary')
            try:
                self.conn = psycopg2.connect(dsn)
                self.mode = 'psycopg2'
                print('[PG] 已连接云库：%s' % self._host_of(dsn))
                return
            except Exception as e:
                raise SystemExit('[PG] 云库连接失败，请检查 JINSHA_DSN：%s' % e)
        try:
            import psycopg2
            self.conn = psycopg2.connect('host=127.0.0.1 port=5432 dbname=%s user=%s' % (db, user))
            self.mode = 'psycopg2'
            return
        except Exception:
            pass
        if self._ok(['psql', '--version']):
            self.mode = 'psql'
        elif self._ok(['docker', 'exec', container, 'psql', '--version']):
            self.mode = 'docker'

    @staticmethod
    def _host_of(dsn):
        for part in dsn.split():
            if part.startswith('host='):
                return part[5:]
        return dsn

    @staticmethod
    def _run(cmd, stdin=None):
        try:
            r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=300,
                               encoding='utf-8', errors='replace')
            return r.returncode == 0, (r.stdout or '') + (r.stderr or '')
        except Exception as e:
            return False, str(e)

    def _ok(self, cmd):
        return self._run(cmd)[0]

    def sql(self, text):
        if self.mode == 'psycopg2':
            with self.conn.cursor() as cur:
                cur.execute(text)
            self.conn.commit()
            return True, ''
        if self.mode == 'psql':
            return self._run(['psql', '-v', 'ON_ERROR_STOP=1', '-d', self.db, '-U', self.user, '-f', '-'], text)
        if self.mode == 'docker':
            return self._run(['docker', 'exec', '-i', self.container, 'psql', '-v', 'ON_ERROR_STOP=1',
                              '-U', self.user, '-d', self.db, '-f', '-'], text)
        return False, '无可用通道'

    def rows(self, text):
        if self.mode == 'psycopg2':
            with self.conn.cursor() as cur:
                cur.execute(text)
                return cur.fetchall()
        flag = '-AtF\t'
        cmd = (['psql', flag, '-d', self.db, '-U', self.user, '-c', text] if self.mode == 'psql'
               else ['docker', 'exec', '-i', self.container, 'psql', flag,
                     '-U', self.user, '-d', self.db, '-c', text])
        ok, out = self._run(cmd)
        return [l.split('\t') for l in out.strip().splitlines() if l] if ok else []


def q(v):
    if v is None:
        return 'NULL'
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return repr(v) if math.isfinite(v) else 'NULL'
    return "'" + str(v).replace("'", "''") + "'"


def num(v, d=None):
    try:
        f = float(v)
        return f if math.isfinite(f) else d
    except Exception:
        return d


DDL = """
CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE IF NOT EXISTS app."站点"(
  "名称" text PRIMARY KEY, "英文" text, "类型" text, "分区" text,
  "经度" double precision, "纬度" double precision, "海拔" double precision,
  "坡度" double precision, "起伏" double precision, "年降水" double precision, "年均温" double precision);
CREATE TABLE IF NOT EXISTS app."土地覆盖"(
  "名称" text PRIMARY KEY, "林地" double precision, "草地灌丛" double precision, "农田" double precision,
  "建成区" double precision, "裸地" double precision, "水体" double precision, "湿地" double precision);
CREATE TABLE IF NOT EXISTS app."生态指标"(
  "名称" text PRIMARY KEY, "FVC" double precision, "碳密度" double precision, "滑坡敏感性" double precision,
  "退化风险" double precision, "土地胁迫" double precision, "综合风险" double precision,
  "EI" double precision, "生态质量" double precision, "生境质量" double precision,
  "生物多样性" double precision, "水源涵养" double precision, "土壤保持" double precision,
  "气候调节" double precision, "生态韧性" double precision, "服务价值" double precision,
  "人类干扰" double precision, "EEI" double precision, "等级" text, "证据级别" text);
CREATE TABLE IF NOT EXISTS app."气候年值"(
  "名称" text, "年份" int, "年均温" double precision, "年降水" double precision, "年蒸散" double precision,
  PRIMARY KEY("名称","年份"));
CREATE TABLE IF NOT EXISTS app."治理台账"(
  "编号" text PRIMARY KEY, "时间" text, "操作人" text, "类型" text, "区域" text,
  "字段" text, "方式" text, "数值" text, "影响站数" int, "原因" text, "来源" text, "已撤销" bool);
CREATE TABLE IF NOT EXISTS app."同步日志"(
  "时间" text, "站点数" int, "指标行数" int, "气候行数" int, "耗时秒" double precision);
CREATE OR REPLACE VIEW app."一站一档" AS
SELECT s.*, e."综合风险", e."EI", e."EEI", e."等级", e."碳密度", e."FVC", e."生境质量"
FROM app."站点" s LEFT JOIN app."生态指标" e ON e."名称" = s."名称";
"""

# 证据级别：每个指标"这个数是怎么来的"，写进库里而不是只写在页面上
EVIDENCE = {
    '海拔': 'A 实测（DEM 采样）', '坡度': 'B 派生（30 m DEM）', '年均温': 'C 再分析（NASA POWER）',
    '年降水': 'C 再分析（NASA POWER）', 'FVC': 'C 遥感反演（Sentinel-2 LULC）',
    '碳密度': 'B 估算（覆盖 × 系数）', '滑坡敏感性': 'B 模型（地形·降水经验加权）',
    '退化风险': 'B 模型（覆盖 + 干燥指数）', '综合风险': 'B 模型', 'EI': 'B 模型（HJ 192 框架）',
    'EEI': 'B 模型（8 维加权）',
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dsn', default=os.environ.get('JINSHA_DSN', ''))
    a = ap.parse_args()
    t0 = time.time()

    stations = (load('stations.json', {}) or {}).get('stations', [])
    climate = (load('climate.json', {}) or {}).get('stations', {})
    gov = load('governance.json', {}) or {}
    if not stations:
        sys.exit('data/stations.json 为空，先在项目里跑一次数据构建')

    pg = Pg(a.dsn or None)
    if not pg.mode:
        sys.exit('没有可用的写库通道（psycopg2 / psql / docker exec jinsha-pg）')
    print('写库通道：%s → %s' % (pg.mode, pg.db))

    ok, msg = pg.sql(DDL)
    if not ok:
        sys.exit('建表失败：' + msg[:400])

    import importlib.util
    spec = importlib.util.spec_from_file_location('srv', os.path.join(ROOT, 'server.py'))
    srv = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(srv)

    site, lc, eco, clim = [], [], [], []
    for st in stations:
        m = srv._m(st)
        nm = st['name']
        site.append("(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)" % (
            q(nm), q(st.get('en', '')), q(st.get('type', '')), q(st.get('zone', '')),
            num(st.get('lon')), num(st.get('lat')), num(srv.eff_val(st, 'elev')),
            num(srv.eff_val(st, 'slope')), num(st.get('relief')),
            num(srv.eff_val(st, 'precip')), num(srv.eff_val(st, 'temp'))))
        lc.append("(%s,%s,%s,%s,%s,%s,%s,%s)" % (
            q(nm), round(srv._f(st, '林地'), 4), round(srv._f(st, '草地灌丛'), 4),
            round(srv._f(st, '农田'), 4), round(srv._f(st, '建成区'), 4),
            round(srv._f(st, '裸地'), 4), round(srv._f(st, '水体'), 4), round(srv._f(st, '湿地'), 4)))
        eco.append("(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)" % (
            q(nm), round(m['fvc'], 4), round(m['carbon'], 2), round(m['slide'], 2),
            round(m['deg'], 2), round(m['lsi'], 2), round(m['risk'], 2),
            round(m['ei'], 2), round(srv.eff_val(st, 'elev') and m['ei'] / 100, 4),
            round(m['habitat'], 4), round(m['biodiversity'], 4), round(m['water'], 1),
            round(m['soil'], 2), round(m['climate'], 4), round(m['resilience'], 4),
            round(m['esv'], 3), round(m['disturbance'], 4), round(m['eei'], 1),
            q(srv._grade(m['eei'])), q(EVIDENCE['EEI'])))
        for r in (climate.get(nm, {}) or {}).get('years', []):
            clim.append("(%s,%d,%s,%s,%s)" % (q(nm), int(r[0]), num(r[1]), num(r[2]), num(r[3])))

    sql = []
    sql.append('TRUNCATE app."站点", app."土地覆盖", app."生态指标", app."气候年值";')
    sql.append('INSERT INTO app."站点" VALUES ' + ','.join(site) + ';')
    sql.append('INSERT INTO app."土地覆盖" VALUES ' + ','.join(lc) + ';')
    sql.append('INSERT INTO app."生态指标" VALUES ' + ','.join(eco) + ';')
    for i in range(0, len(clim), 400):
        sql.append('INSERT INTO app."气候年值" VALUES ' + ','.join(clim[i:i + 400]) + ';')
    ch = gov.get('changes', [])
    if ch:
        vals = ["(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)" % (
            q(c.get('id')), q(c.get('t')), q(c.get('user')), q(c.get('kind')), q(c.get('regionName')),
            q(c.get('fieldNm', c.get('field'))), q(c.get('op')), q(str(c.get('value', ''))),
            int(c.get('n') or 0), q(c.get('reason')), q(c.get('source')), q(bool(c.get('undone'))))
            for c in ch[-200:]]
        sql.append('DELETE FROM app."治理台账" WHERE "编号" IS NOT NULL;')
        sql.append('INSERT INTO app."治理台账" VALUES ' + ','.join(vals) + ' ON CONFLICT ("编号") DO NOTHING;')
    sql.append('INSERT INTO app."同步日志" VALUES (%s,%d,%d,%d,%s);' % (
        q(time.strftime('%Y-%m-%d %H:%M:%S')), len(site), len(eco), len(clim), round(time.time() - t0, 1)))

    ok, msg = pg.sql('\n'.join(sql))
    if not ok:
        sys.exit('写入失败：' + msg[:600])

    counts = {}
    for t in ('站点', '土地覆盖', '生态指标', '气候年值', '治理台账', '同步日志'):
        r = pg.rows('SELECT count(*) FROM app."%s";' % t)
        counts[t] = int(r[0][0]) if r and r[0] and r[0][0].isdigit() else 0
    status = {'ok': True, 'time': time.strftime('%Y-%m-%d %H:%M:%S'), 'mode': pg.mode,
              'db': pg.db, 'schema': 'app', 'counts': counts,
              'sample': (pg.rows('SELECT "名称","综合风险","EEI","等级" FROM app."生态指标" '
                                 'ORDER BY "EEI" DESC LIMIT 3;') or [])}
    json.dump(status, open(STATUS, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('已写入 app schema：' + '　'.join('%s %d 行' % (k, v) for k, v in counts.items()))
    print('状态文件 data/pg_status.json（/api/db/status 读取）')


if __name__ == '__main__':
    main()
