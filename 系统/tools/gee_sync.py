# -*- coding: utf-8 -*-
"""
GEE 遥感数据同步：把 Google Earth Engine 上的流域公开遥感产品，按「站点 × 月 / 年」
提取为可计算的数值序列，写入 jinsha 库与前端运行时缓存。

为什么是"按站点提取"而不是存栅格
  本项目的运行时服务（server.py）刻意只用 Python 标准库、随 exe 免安装分发，
  不可能扛 PB 级栅格。GEE 的价值是"云端算、只取结果"：
  在 GEE 里做云掩膜、合成、分区统计，落地成 20 站 × 300 月的数值表（几千行），
  这样既有真实遥感数据，又保住离线可用与秒级响应。

用法
  python tools/gee_sync.py --check                      # 只校验凭据 / 数据集 / 样本数，不写库
  python tools/gee_sync.py --metrics ndvi,precip --start 2015 --end 2024
  python tools/gee_sync.py --full                       # 全量重算（默认增量）
  python tools/gee_sync.py --export-only                # 只从库导出运行时 JSON
  python tools/gee_sync.py --dry-run                    # 打印计划，不连 GEE

依赖（只装在批处理端，不影响 server.py）
  pip install earthengine-api
  # 写库二选一：psycopg2-binary，或本机 psql，或 docker exec jinsha-pg psql（本项目默认有 PG 容器）

认证（二选一）
  1) 服务账号：把 GEE 服务账号 JSON 存为 tools/gee-key.json，并填 --project
  2) 个人授权：先跑一次 `earthengine authenticate`，再用 --project 指定已注册的 Cloud 项目
  GEE 自 2024-11 起必须绑定 Cloud 项目；非商业用途免费（Community 档每月 150 EECU-hours）。

产物
  data/gee/meta.json      同步元数据（数据集、覆盖年份、最后运行时间、版本号）
  data/gee/series.json    运行时序列缓存：{站点: {指标: [[年月, 值, 质量], ...]}}
  data/gee/annual.json    年值（生长季均值 / 年累计）
  data/gee/trend.json     逐年趋势（Sen 斜率 + Mann-Kendall 显著性）
  PostgreSQL jinsha       遥感月值 / 遥感年值 / 遥感趋势 / 遥感同步日志（表结构见 data/sql/gee_tables.sql）
"""
import argparse, json, math, os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
GEEDIR = os.path.join(DATA, 'gee')
KEY = os.path.join(ROOT, 'tools', 'gee-key.json')

# ------------------------------------------------------------------ 数据集注册表
# scale/offset 按各产品文档的定标系数集中在这里，避免散落在业务代码里
# mask：云/雪/阴影掩膜策略，见 mask_image()
DS = {
    'ndvi': {
        'name': '植被指数 NDVI', 'collection': 'MODIS/061/MOD13Q1', 'band': 'NDVI',
        'scale': 0.0001, 'offset': 0, 'unit': '1', 'valid': (-0.2, 1.0),
        'start': '2000-02', 'freq': 'month', 'agg': 'mean', 'mask': 'mod13qa',
        'note': '16 天合成取月内均值；配合 EVI 可缓解饱和',
    },
    'evi': {
        'name': '增强植被指数 EVI', 'collection': 'MODIS/061/MOD13Q1', 'band': 'EVI',
        'scale': 0.0001, 'offset': 0, 'unit': '1', 'valid': (-0.2, 1.0),
        'start': '2000-02', 'freq': 'month', 'agg': 'mean', 'mask': 'mod13qa',
        'note': 'EVI 在高覆盖区不易饱和，适合做退化趋势',
    },
    'treecover': {
        'name': '树冠覆盖度', 'collection': 'MODIS/061/MOD44B', 'band': 'Percent_Tree_Cover',
        'scale': 1, 'offset': 0, 'unit': '%', 'valid': (0, 100),
        'start': '2000-01', 'freq': 'year', 'agg': 'mean', 'mask': 'none',
        'note': '250 m 年产品，气温/降水无关，可替代现有 5 km 缓冲估算值',
    },
    'lst': {
        'name': '地表温度', 'collection': 'MODIS/061/MOD11A2', 'band': 'LST_Day_1km',
        'scale': 0.02, 'offset': -273.15, 'unit': '℃', 'valid': (-30, 60),
        'start': '2000-03', 'freq': 'month', 'agg': 'mean', 'mask': 'mod11qa',
        'note': '0.02 K 定标，减 273.15 转摄氏度',
    },
    'precip': {
        'name': '卫星降水', 'collection': 'NASA/GPM_L3/IMERG_MONTHLY_V07',
        'band': 'precipitation', 'scale': 1000, 'offset': 0, 'unit': 'mm', 'valid': (0, 2000),
        'start': '2000-06', 'freq': 'month', 'agg': 'sum', 'mask': 'none',
        'note': '产品原始单位为 m/月，×1000 转 mm/月；与 NASA POWER 逐点序列互为校验',
    },
    'temp': {
        'name': '2 m 气温', 'collection': 'ECMWF/ERA5_LAND/MONTHLY_AGGR',
        'band': 'temperature_2m', 'scale': 1, 'offset': -273.15, 'unit': '℃', 'valid': (-30, 45),
        'start': '1950-01', 'freq': 'month', 'agg': 'mean', 'mask': 'none',
        'note': 'K→℃；ERA5-Land 0.1°，比 MERRA-2 0.5° 更贴合山地',
    },
    'et': {
        'name': '实际蒸散', 'collection': 'ECMWF/ERA5_LAND/MONTHLY_AGGR',
        'band': 'total_evaporation_sum', 'scale': -1000, 'offset': 0, 'unit': 'mm',
        'valid': (-500, 800), 'start': '1950-01', 'freq': 'month', 'agg': 'sum', 'mask': 'none',
        'note': 'ERA5 的蒸散为负值（向下），乘 -1000 转 mm/月正数',
    },
    'tcc30': {
        'name': '树冠覆盖度 30m', 'collection': 'UMD/hansen/global_forest_change_2024_v1_12',
        'band': 'treecover2000', 'scale': 1, 'offset': 0, 'unit': '%', 'valid': (0, 100),
        'start': 'static', 'freq': 'static', 'agg': 'mean', 'mask': 'none',
        'note': 'Hansen 全球森林变化 30 m，treecover2000 为 2000 年冠层覆盖百分比；'
                '当前值还需扣除 lossyear 累计损失，静态表先存基准',
    },
    'soil_oc': {
        'name': '土壤有机碳', 'collection': 'OPENLANDMAP/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02',
        'band': 'b0', 'scale': 5, 'offset': 0, 'unit': 'g/kg', 'valid': (0, 500),
        'start': 'static', 'freq': 'static', 'agg': 'mean', 'mask': 'none',
        'note': 'SoilGrids/OpenLandMap 250 m 静态面，补齐"土壤要素"',
    },
    'agbd': {
        'name': '地上生物量', 'collection': 'LARSE/GEDI/GEDI04_A_002_MONTHLY',
        'band': 'agbd', 'scale': 1, 'offset': 0, 'unit': 'Mg/ha', 'valid': (0, 500),
        'start': '2019-04', 'freq': 'month', 'agg': 'mean', 'mask': 'gedi',
        'note': 'GEDI L4A 月合成；条带式采样，缺失月属正常，需按季节插补',
    },
}

# 年值聚合口径：生长季（5–9 月）均值更适合植被，年累计适合降水
ANNUAL = {
    'ndvi': {'how': 'grow', 'months': (5, 6, 7, 8, 9)},
    'evi': {'how': 'grow', 'months': (5, 6, 7, 8, 9)},
    'treecover': {'how': 'mean'},
    'lst': {'how': 'grow', 'months': (5, 6, 7, 8, 9)},
    'precip': {'how': 'sum'},
    'temp': {'how': 'mean'},
    'et': {'how': 'sum'},
}


# ------------------------------------------------------------------ GEE 侧
def init_ee(project):
    """初始化 Earth Engine。凭据缺失时给出可操作的提示，而不是抛一串堆栈。"""
    try:
        import ee
    except ImportError:
        sys.exit('缺少 earthengine-api：pip install earthengine-api')
    if os.path.exists(KEY):
        from google.oauth2 import service_account
        cred = service_account.Credentials.from_service_account_file(KEY)
        cred = cred.with_scopes(['https://www.googleapis.com/auth/earthengine',
                                 'https://www.googleapis.com/auth/cloud-platform'])
        ee.Initialize(cred, project=project)
        return ee, 'service-account'
    try:
        ee.Initialize(project=project)
        return ee, 'user-oauth'
    except Exception as e:
        sys.exit('GEE 初始化失败：%s\n  1) 把服务账号 JSON 放到 tools/gee-key.json，或先执行 earthengine authenticate\n'
                 '  2) Cloud 项目需已启用 Earth Engine API 并完成非商业注册\n'
                 '  3) 用 --project 指定项目 ID' % e)


def mask_image(ee, img, how):
    """云 / 雪 / 阴影掩膜。每种产品用官方推荐的 QA 位，不做"启发式去云"。"""
    if how == 'none':
        return img
    if how == 'mod13qa':                     # MOD13Q1 SummaryQA：0 优 1 良 2 边缘 3 雪冰
        qa = img.select('SummaryQA')
        return img.updateMask(qa.lte(1))
    if how == 'mod11qa':                     # MOD11A2 QC_Day 低 2 位：00 最高质量
        qa = img.select('QC_Day')
        return img.updateMask(qa.bitwiseAnd(3).lte(1))
    if how == 'gedi':                        # L4A 质量位：仅保留高质量、无降级
        return img.updateMask(img.select('l4_quality_flag').eq(1)
                              .And(img.select('degrade_flag').eq(0)))
    return img


def station_fc(ee, stations, radius_m):
    """站点缓冲区：默认 1 km 圆，避免单像元落在混合地物上。"""
    feats = []
    for s in stations:
        pt = ee.Geometry.Point([s['lon'], s['lat']]).buffer(radius_m)
        feats.append(ee.Feature(pt, {'name': s['name'], 'sid': s['id']}))
    return ee.FeatureCollection(feats)


def monthly_composite(ee, ds, coll, y, m):
    """某年某月的合成影像（已掩膜、已按 agg 聚合）。"""
    import calendar
    t0 = '%d-%02d-01' % (y, m)
    t1 = '%d-%02d-%02d' % (y, m, calendar.monthrange(y, m)[1])
    sub = coll.filterDate(t0, t1)
    if sub.size().getInfo() == 0:
        return None                      # 该月无影像（产品尚未覆盖），跳过而不是产出空波段
    if ds['agg'] == 'sum':
        img = sub.map(lambda i: mask_image(ee, i, ds['mask'])).sum()
    elif ds['agg'] == 'mode':
        img = sub.map(lambda i: mask_image(ee, i, ds['mask'])).mode()
    else:
        img = sub.map(lambda i: mask_image(ee, i, ds['mask'])).mean()
    return img.select([ds['band']]).rename('%s_%d_%02d' % (ds['band'], y, m))


def stack_year(ee, key, ds, coll, y, radius, stations, months):
    """把一年 12 个月合成到一张多波段影像，再一次性 reduceRegions。

    这是整条链路最关键的性能设计：逐月 reduceRegions 是 12 次往返，
    叠成 12 波段只往返 1 次，25 年从 300 次降到 25 次。
    """
    img, got = None, 0
    for m in months:
        band = monthly_composite(ee, ds, coll, y, m)
        if band is None:
            continue
        img = band if img is None else img.addBands(band)
        got += 1
    if img is None or got == 0:
        return []
    fc = img.reduceRegions(collection=station_fc(ee, stations, radius),
                           reducer=ee.Reducer.mean().combine(ee.Reducer.count(), '', True),
                           scale=ds.get('_scale', 250), tileScale=4)
    return fc.getInfo()['features']


def stack_year_annual(ee, key, ds, coll, y, radius, stations):
    """年产品（如 MOD44B 树冠覆盖）：一年一幅，直接取当年影像。"""
    sub = coll.filterDate('%d-01-01' % y, '%d-12-31' % y)
    if sub.size().getInfo() == 0:
        return []
    img = sub.map(lambda i: mask_image(ee, i, ds['mask'])).mean() \
             .select([ds['band']]).rename('tcc')   # 短名避免属性名被改写
    fc = img.reduceRegions(collection=station_fc(ee, stations, radius),
                           reducer=ee.Reducer.mean().combine(ee.Reducer.count(), '', True),
                           scale=ds.get('_scale', 250), tileScale=4)
    return fc.getInfo()['features']


# ------------------------------------------------------------------ 质量控制
def qc_value(v, ds):
    """单位定标 + 物理区间裁剪 + 质量标记。任何一步不过关都保留原值并打标，
    绝不静默丢数——这是数据可信度的底线。"""
    if v is None:
        return None, 'missing'
    try:
        x = float(v) * ds['scale'] + ds['offset']
    except Exception:
        return None, 'bad'
    if not math.isfinite(x):
        return None, 'missing'
    lo, hi = ds['valid']
    if x < lo or x > hi:
        return round(x, 4), 'out_of_range'
    return round(x, 4), 'ok'


def fill_missing(series, gaps_max=3):
    """缺失值处理：短缺口（≤3 个月）线性插补并标 'interp'；长缺口保留 None。
    不做"全年插值"——那会把季节波动抹平，做趋势时会造假信号。"""
    n = len(series)
    for i in range(n):
        if series[i][1] is not None:
            continue
        prev = next((j for j in range(i - 1, -1, -1) if series[j][1] is not None), None)
        nxt = next((j for j in range(i + 1, n) if series[j][1] is not None), None)
        if prev is None or nxt is None or (nxt - prev) > gaps_max + 1:
            continue
        v0, v1 = series[prev][1], series[nxt][1]
        w = (i - prev) / (nxt - prev)
        series[i][1] = round(v0 + (v1 - v0) * w, 4)
        series[i][2] = 'interp'
    return series


def sen_mk(values):
    """Sen 斜率 + Mann-Kendall 检验（与库中「气候趋势」表同口径）。"""
    xs = [i for i, v in enumerate(values) if v is not None]
    ys = [values[i] for i in xs]
    n = len(ys)
    if n < 10:
        return None
    slopes = []
    for i in range(n - 1):
        for j in range(i + 1, n):
            if xs[j] != xs[i]:
                slopes.append((ys[j] - ys[i]) / (xs[j] - xs[i]))
    slopes.sort()
    sen = slopes[len(slopes) // 2] if slopes else 0.0
    s = 0
    for i in range(n - 1):
        for j in range(i + 1, n):
            d = ys[j] - ys[i]
            s += 1 if d > 0 else (-1 if d < 0 else 0)
    var = n * (n - 1) * (2 * n + 5) / 18.0
    if var <= 0:
        return {'sen': round(sen, 5), 'z': 0.0, 'p': 1.0}
    z = (s - (1 if s > 0 else -1)) / math.sqrt(var) if s else 0.0
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    return {'sen': round(sen, 5), 'z': round(z, 3), 'p': round(p, 4)}


# ------------------------------------------------------------------ 写库
class Pg:
    """写库后端：psycopg2 → 本机 psql → docker exec psql，三级降级。
    学院机器上常常只有 Docker，没有 Python 驱动；不因为缺一个包就整条链路失败。"""

    def __init__(self, dsn=None, container='jinsha-pg', db='jinsha', user='postgres'):
        self.mode = None
        self.conn = None
        self.container, self.db, self.user = container, db, user
        dsn = dsn or os.environ.get('JINSHA_DSN')
        if dsn:
            # 指定了远程/云库 DSN：只走 psycopg2，失败要报错，绝不静默降级到本地库（否则三人数据分家）
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
        # 本地默认通道：psycopg2 → docker exec → 本机 psql
        try:
            import psycopg2
            self.conn = psycopg2.connect('host=127.0.0.1 port=5432 dbname=%s user=%s' % (db, user))
            self.mode = 'psycopg2'
            return
        except Exception:
            pass
        if self._run(['docker', 'exec', container, 'psql', '--version']):
            self.mode = 'docker'
            return
        if self._run(['psql', '--version']):
            self.mode = 'psql'
            return
        self.mode = None

    @staticmethod
    def _host_of(dsn):
        for part in dsn.split():
            if part.startswith('host='):
                return part[5:]
        return dsn

    def _run(self, cmd, stdin=None):
        try:
            # 必须显式 utf-8：Windows 默认用 GBK 编码 stdin，中文站点名会让 psql 报 0xb8 非法字节
            r = subprocess.run(cmd, input=stdin, capture_output=True, text=True,
                               encoding='utf-8', errors='replace', timeout=300)
            return r.returncode == 0, (r.stdout or '') + (r.stderr or '')
        except Exception:
            return False, ''

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
        return False, '无可用写库通道'

    def rows(self, text):
        """查询：统一返回二维列表，便于三种通道共用一套解析。"""
        if self.mode == 'psycopg2':
            with self.conn.cursor() as cur:
                cur.execute(text)
                return [[('' if c is None else c) for c in r] for r in cur.fetchall()]
        flag = '-At'
        cmd = (['psql', flag, '-F', '\t', '-d', self.db, '-U', self.user, '-c', text] if self.mode == 'psql'
               else ['docker', 'exec', '-i', self.container, 'psql', flag, '-F', '\t',
                     '-U', self.user, '-d', self.db, '-c', text])
        ok, out = self._run(cmd)
        return [l.split('\t') for l in out.strip().splitlines() if l] if ok else []


def esc(v):
    if v is None:
        return 'NULL'
    if isinstance(v, (int, float)):
        return repr(v) if math.isfinite(v) else 'NULL'
    return "'" + str(v).replace("'", "''") + "'"


# ------------------------------------------------------------------ 主导航
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只校验凭据与数据集可用性')
    ap.add_argument('--dry-run', action='store_true', help='打印计划，不连 GEE 不写库')
    ap.add_argument('--full', action='store_true', help='全量重算（默认按已有年份增量）')
    ap.add_argument('--export-only', action='store_true', help='只从库导出运行时 JSON')
    ap.add_argument('--metrics', default='', help='逗号分隔，如 ndvi,precip,soil_oc')
    ap.add_argument('--start', type=int, default=0)
    ap.add_argument('--end', type=int, default=0)
    ap.add_argument('--project', default=os.environ.get('GEE_PROJECT', ''))
    ap.add_argument('--radius', type=int, default=1000, help='站点缓冲区半径 m')
    ap.add_argument('--pg', default='', help='关闭写库：--pg off')
    a = ap.parse_args()

    os.makedirs(GEEDIR, exist_ok=True)
    st_path = os.path.join(DATA, 'stations.json')
    stations = json.load(open(st_path, encoding='utf-8'))['stations']

    keys = [k.strip() for k in a.metrics.split(',') if k.strip()] or \
           [k for k in DS if DS[k]['start'] != 'static']
    years = None
    if a.start:
        end = a.end or time.gmtime().tm_year
        years = list(range(a.start, end + 1))

    if a.dry_run:
        print('计划：%d 站 × %d 指标' % (len(stations), len(keys)))
        for k in keys:
            d = DS[k]
            print('  %-10s %-38s %-8s %-6s %s' % (k, d['collection'], d['freq'], d['unit'], d['start']))
        print('年份：%s' % ('全部（按产品起始年）' if not years else '%d–%d' % (years[0], years[-1])))
        return

    if a.export_only:
        export_runtime(Pg())
        return

    if not a.project:
        sys.exit('缺少 --project（Earth Engine 绑定的 Cloud 项目 ID）')
    ee, auth = init_ee(a.project)
    print('GEE 已连接（%s），项目 %s' % (auth, a.project))

    if a.check:
        for k in keys:
            d = DS[k]
            try:
                col = ee.ImageCollection(d['collection'])
                n = col.size().getInfo()
                first = col.sort('system:time_start').first()
                bands = first.bandNames().getInfo()
                print('  ✓ %-10s %-44s 影像 %6d 幅 波段 %s' % (k, d['collection'], n, bands[:6]))
                if d['band'] not in bands:
                    print('    ！注册表里的 band=%s 不在数据集中，请改正' % d['band'])
            except Exception as e:
                print('  ✗ %-10s %s' % (k, str(e)[:90]))
        return

    pg = Pg() if a.pg != 'off' else Pg.__new__(Pg())
    if a.pg == 'off':
        pg.mode = None
    print('写库通道：%s' % (pg.mode or '仅写运行时 JSON'))

    out = {}
    t_start = time.time()
    for k in keys:
        d = DS[k]
        print('\n[%s] %s' % (k, d['name']))
        d['_scale'] = 250 if 'MODIS' in d['collection'] else (1000 if 'ERA5' in d['collection'] else 250)
        if d['start'] == 'static':
            rows = sync_static(ee, k, d, stations, a.radius)
            if rows:
                out[k] = rows
                write_static(pg, k, d, rows)
            continue
        ys = years or list(range(int(d['start'][:4]), time.gmtime().tm_year + 1))
        coll = ee.ImageCollection(d['collection'])
        series = {s['name']: [] for s in stations}
        if d['freq'] == 'year':
            for y in ys:
                try:
                    feats = stack_year_annual(ee, k, d, coll, y, a.radius, stations)
                except Exception as e:
                    print('  %d 年失败：%s' % (y, str(e)[:110]))
                    continue
                for f in feats:
                    nm = f['properties'].get('name')
                    if nm not in series:
                        continue
                    props = f['properties']
                    raw = props.get('tcc_mean') or props.get('%s_%d_mean' % (d['band'], y))
                    if raw is None:      # 属性名被 Google 改写：取第一个数值型属性兜底
                        cand = [v for k2, v in props.items()
                                if k2 not in ('name', 'sid', 'system:index')
                                and not k2.endswith('_count')
                                and isinstance(v, (int, float))]
                        raw = cand[0] if cand else None
                    val, q = qc_value(raw, d)
                    series[nm].append([str(y), val, q])
                print('  %d 年 · %d 站' % (y, len(feats)), flush=True)
            out[k] = series
            write_series(pg, k, d, series)
            write_annual(pg, k, d, series)
            write_trend(pg, k, d, series)
            continue
        for y in ys:
            months = range(1, 13)
            if y == ys[0]:
                months = range(int(d['start'][5:7]), 13)
            if y == time.gmtime().tm_year:
                months = range(1, time.gmtime().tm_mon + 1)
            try:
                feats = stack_year(ee, k, d, coll, y, a.radius, stations, months)
            except Exception as e:
                print('  %d 年失败：%s' % (y, str(e)[:110]))
                continue
            for f in feats:
                nm = f['properties'].get('name')
                if nm not in series:
                    continue
                for m in months:
                    key = '%s_%d_%02d' % (d['band'], y, m)
                    raw = f['properties'].get(key + '_mean')
                    cnt = f['properties'].get(key + '_count') or 0
                    val, q = qc_value(raw, d)
                    if q == 'ok' and cnt < 1:
                        val, q = None, 'missing'      # 合成后整月无有效像元（全云）
                    series[nm].append(['%d-%02d' % (y, m), val, q])
            print('  %d 年 · %d 站 · %d 个月' % (y, len(feats), len(months)), flush=True)
        for nm in series:
            series[nm].sort()
            series[nm] = fill_missing(series[nm])
        out[k] = series
        write_series(pg, k, d, series)
        write_annual(pg, k, d, series)
        write_trend(pg, k, d, series)

    # 运行时缓存
    save_runtime(out)
    log_sync(pg, keys, len(stations), time.time() - t_start)
    print('\n完成，用时 %.1f s；产物在 data/gee/（server.py 直接读取）' % (time.time() - t_start))


def sync_static(ee, k, d, stations, radius):
    img = ee.Image(d['collection']).select([d['band']])
    fc = img.reduceRegions(collection=station_fc(ee, stations, radius),
                           reducer=ee.Reducer.mean(), scale=250, tileScale=4).getInfo()
    out = {}
    for f in fc['features']:
        v, q = qc_value(f['properties'].get('mean'), d)
        out[f['properties']['name']] = [['static', v, q]]
    return out


def write_series(pg, key, d, series):
    if not pg.mode:
        return
    vals = []
    for nm, arr in series.items():
        for ym, v, q in arr:
            vals.append('(%s,%s,%s,%s,%s,%s,%s,%s)' % (
                esc(nm), esc(ym), esc(key), esc(d['name']), esc(v), esc(d['unit']), esc(q), 'now()'))
    if not vals:
        return
    sql = ('INSERT INTO "遥感月值"("站点","年月","指标代码","指标名称","数值","单位","质量标记","采集时间") VALUES '
           + ','.join(vals) + ' ON CONFLICT ("站点","年月","指标代码") DO UPDATE SET '
             '"数值"=EXCLUDED."数值","质量标记"=EXCLUDED."质量标记","采集时间"=now();')
    ok, msg = pg.sql(sql)
    print('  写库 遥感月值 %s（%d 行）' % ('成功' if ok else '失败：' + msg[:80], len(vals)))


def write_annual(pg, key, d, series):
    rule = ANNUAL.get(key)
    if not rule or not pg.mode:
        return
    vals = []
    by_year = {}
    for nm, arr in series.items():
        for ym, v, q in arr:
            if v is None:
                continue
            parts = ym.split('-'); y, m = parts[0], (parts[1] if len(parts) > 1 else '07')
            if rule['how'] == 'grow' and int(m) not in rule['months']:
                continue
            by_year.setdefault((nm, y), []).append(v)
    for (nm, y), vs in by_year.items():
        val = sum(vs) if rule['how'] == 'sum' else sum(vs) / len(vs)
        vals.append('(%s,%s,%s,%s,%s,%s,now())' % (esc(nm), esc(y), esc(key), esc(round(val, 4)),
                                                   esc(d['unit']), esc('ok' if len(vs) >= 6 else 'sparse')))
    if not vals:
        return
    sql = ('INSERT INTO "遥感年值"("站点","年份","指标代码","数值","单位","质量标记","采集时间") VALUES '
           + ','.join(vals) + ' ON CONFLICT ("站点","年份","指标代码") DO UPDATE SET '
             '"数值"=EXCLUDED."数值","质量标记"=EXCLUDED."质量标记","采集时间"=now();')
    ok, msg = pg.sql(sql)
    print('  写库 遥感年值 %s（%d 行）' % ('成功' if ok else '失败：' + msg[:80], len(vals)))


def write_trend(pg, key, d, series):
    if not pg.mode:
        return
    vals = []
    for nm, arr in series.items():
        ys = {}
        for ym, v, q in arr:
            if v is None:
                continue
            ys.setdefault(ym[:4], []).append(v)
        seq = [round(sum(v) / len(v), 4) if len(v) else None for _, v in sorted(ys.items())]
        r = sen_mk(seq)
        if not r:
            continue
        trend = '显著上升' if (r['sen'] > 0 and r['p'] < 0.05) else \
                ('显著下降' if (r['sen'] < 0 and r['p'] < 0.05) else '无显著趋势')
        vals.append('(%s,%s,%s,%s,%s,%s,%s,now())' % (
            esc(nm), esc(key), esc(r['sen']), esc(r['z']), esc(r['p']), esc(trend), esc(d['unit'])))
    if not vals:
        return
    sql = ('INSERT INTO "遥感趋势"("站点","指标代码","Sen斜率","MK_Z","MK_P","趋势","单位","采集时间") VALUES '
           + ','.join(vals) + ' ON CONFLICT ("站点","指标代码") DO UPDATE SET '
             '"Sen斜率"=EXCLUDED."Sen斜率","MK_Z"=EXCLUDED."MK_Z","MK_P"=EXCLUDED."MK_P",'
             '"趋势"=EXCLUDED."趋势","采集时间"=now();')
    ok, msg = pg.sql(sql)
    print('  写库 遥感趋势 %s（%d 站）' % ('成功' if ok else '失败：' + msg[:80], len(vals)))


def write_static(pg, key, d, rows):
    if not pg.mode or not rows:
        return
    vals = ['(%s,%s,%s,%s,%s,now())' % (esc(nm), esc(key), esc(d['name']), esc(v[0][1]), esc(d['unit']))
            for nm, v in rows.items()]
    sql = ('INSERT INTO "遥感静态值"("站点","指标代码","指标名称","数值","单位","采集时间") VALUES '
           + ','.join(vals) + ' ON CONFLICT ("站点","指标代码") DO UPDATE SET '
             '"数值"=EXCLUDED."数值","采集时间"=now();')
    ok, msg = pg.sql(sql)
    print('  写库 遥感静态值 %s（%d 站）' % ('成功' if ok else '失败：' + msg[:80], len(vals)))


def _read_json(name, default):
    fp = os.path.join(GEEDIR, name)
    if not os.path.isfile(fp):
        return default
    try:
        return json.load(open(fp, encoding='utf-8'))
    except Exception:
        return default


def save_runtime(out):
    """运行时缓存：按指标**合并**写入，不是整份覆盖。
    分指标跑（--metrics ndvi 然后 --metrics temp）时，前面的指标不能丢。"""
    meta = _read_json('meta.json', {}) or {}
    old_series = _read_json('series.json', {}) or {}
    old_annual = _read_json('annual.json', {}) or {}
    metrics = dict(meta.get('metrics') or {})

    series = dict(old_series)
    annual = dict(old_annual)
    for k, v in out.items():
        series[k] = v
        metrics[k] = {'name': DS[k]['name'], 'unit': DS[k]['unit'],
                      'collection': DS[k]['collection'], 'freq': DS[k]['freq']}
        rule = ANNUAL.get(k)
        if not rule:
            continue
        a = {}
        for nm, arr in v.items():
            by = {}
            for ym, val, q in arr:
                if val is None:
                    continue
                parts = ym.split('-')
                y, m = parts[0], (parts[1] if len(parts) > 1 else '07')
                if rule['how'] == 'grow' and int(m) not in rule['months']:
                    continue
                by.setdefault(y, []).append(val)
            a[nm] = [[y, round(sum(x) if rule['how'] == 'sum' else sum(x) / len(x), 4)]
                     for y, x in sorted(by.items())
                     if len(x) >= (4 if rule['how'] == 'grow'
                                   else (6 if DS[k]['freq'] == 'month' else 1))]
        annual[k] = a

    meta = {'version': time.strftime('%Y.%m.%d-%H%M'), 'updated': time.strftime('%Y-%m-%d %H:%M:%S'),
            'source': 'Google Earth Engine', 'radius_m': meta.get('radius_m', 1000),
            'metrics': metrics}
    json.dump(meta, open(os.path.join(GEEDIR, 'meta.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    json.dump(series, open(os.path.join(GEEDIR, 'series.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    json.dump(annual, open(os.path.join(GEEDIR, 'annual.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    print('  运行时缓存已合并写入 data/gee/（累计 %d 个指标）' % len(metrics))


def export_runtime(pg):
    """只从库重建缓存（改了清洗规则后不必重跑 GEE，省钱省时间）。"""
    if not pg.mode:
        sys.exit('未找到可用数据库通道')
    out = {}
    rows = pg.rows('SELECT "指标代码","站点","年月","数值","质量标记" FROM "遥感月值" ORDER BY 1,2,3')
    for code, nm, ym, v, q in rows:
        out.setdefault(code, {}).setdefault(nm, []).append([ym, float(v) if v != '' else None, q])
    save_runtime(out)


def log_sync(pg, keys, n, dur):
    if not pg.mode:
        return
    pg.sql('INSERT INTO "遥感同步日志"("开始时间","指标","站点数","耗时秒","状态") VALUES (%s,%s,%s,%s,%s);'
           % (esc(time.strftime('%Y-%m-%d %H:%M:%S')), esc(','.join(keys)), n, round(dur, 1), esc('ok')))


if __name__ == '__main__':
    main()
