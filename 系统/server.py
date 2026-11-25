# -*- coding: utf-8 -*-
"""
金沙江流域森林生态环境智能评估系统 · 服务端
仅依赖 Python 标准库（无需 pip install）。

功能
  · 账号登录（PBKDF2 加盐哈希 + 服务端会话 Cookie）
  · 局域网访问：默认监听 0.0.0.0:8080，同一网络内其他电脑可用 http://本机IP:8080 打开
  · 静态资源与数据接口（gzip 压缩）
  · 站点数据新增 / CSV 导入 / 导出 / 审计日志
  · 新增站点时实时补齐 DEM 高程、坡度、影像绿度、土地覆盖（联网时）

用法
  python server.py                    启动（默认 0.0.0.0:8080）
  python server.py --port 9000        指定端口
  python server.py --set-password     修改当前用户密码
"""
import base64, calendar, csv, gzip, hashlib, hmac, io, json, math, os, random, re, secrets, socket, sys, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as FT   # 功能补全模块：ML训练 / 情景 / 导出 / 真实任务系统

if getattr(sys, 'frozen', False):
    # 打包成 exe 后：程序目录是 PyInstaller 的临时解包目录，只读且每次运行都会变
    ROOT = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
else:
    ROOT = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(ROOT, 'web')
# 可写数据（账号、站点、审计）由启动器指向 %LOCALAPPDATA%\JinshaEco\data，
# 不放进 exe 里，否则每次运行都会丢掉新增站点和改过的密码
DATA = os.environ.get('JINSHA_DATA') or os.path.join(ROOT, 'data')
USERS = os.path.join(DATA, 'users.json')
STATIONS = os.path.join(DATA, 'stations.json')
AUDIT = os.path.join(DATA, 'audit.log')

HOST, PORT = '0.0.0.0', int(os.environ.get('PORT', 8080))
SESSION_TTL = 12 * 3600
MAX_FAIL, FAIL_WINDOW = 8, 600
MAX_BODY = 8 * 1024 * 1024          # 单个请求体上限，防止 Content-Length 撑爆内存
AUDIT_MAX = 2 * 1024 * 1024         # 审计日志轮转阈值


CSP_CESIUM = ("default-src 'self'; img-src 'self' data: blob: https:; "
              "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; "
              "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; "
              "font-src 'self' data: https://cdn.jsdelivr.net; worker-src 'self' blob:; "
              "frame-ancestors 'self'; base-uri 'self'; object-src 'none'")

CSP = ("default-src 'self'; img-src 'self' data: blob: https:; "
       "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "
       "connect-src 'self' https: http://localhost:* http://127.0.0.1:*; "
       "font-src 'self' data:; worker-src 'self' blob:; "
       "frame-ancestors 'self'; base-uri 'self'; object-src 'none'")

# ------------------------------------------------------------------ 基础工具
def now(): return time.strftime('%Y-%m-%d %H:%M:%S')
def log(*a): print('[%s]' % time.strftime('%H:%M:%S'), *a, flush=True)

def load_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f: return json.load(f)
    except Exception: return default

def save_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)

def audit(rec):
    """写审计日志；超过 2 MB 自动轮转成 audit.log.1，避免无限增长。"""
    try:
        if os.path.exists(AUDIT) and os.path.getsize(AUDIT) > AUDIT_MAX:
            try: os.replace(AUDIT, AUDIT + '.1')
            except Exception: pass
        with open(AUDIT, 'a', encoding='utf-8') as f:
            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
    except Exception:
        pass

def pbkdf2(pw, salt):
    return hashlib.pbkdf2_hmac('sha256', pw.encode('utf-8'), salt, 180000).hex()

def init_users():
    """首次运行生成随机口令，而不是写死一个谁都知道的密码。"""
    if os.path.exists(USERS): return
    salt = secrets.token_bytes(16)
    pw = secrets.token_urlsafe(9)
    save_json(USERS, {"users": [{
        "u": "why", "name": "why", "role": "admin",
        "salt": salt.hex(), "hash": pbkdf2(pw, salt), "created": now()
    }]})
    log('=' * 54)
    log('  已创建初始账号  why')
    log('  初始密码  %s' % pw)
    log('  请登录后在「设置 → 修改密码」里换成自己的密码')
    log('=' * 54)

def check_user(u, p):
    db = load_json(USERS, {"users": []})
    for it in db.get('users', []):
        if it['u'] == u:
            return hmac.compare_digest(pbkdf2(p, bytes.fromhex(it['salt'])), it['hash']), it
    return False, None

def set_password(username, pw):
    db = load_json(USERS, {"users": []})
    for it in db['users']:
        if it['u'] == username:
            salt = secrets.token_bytes(16)
            it['salt'], it['hash'] = salt.hex(), pbkdf2(pw, salt)
            save_json(USERS, db); return True
    return False

# ------------------------------------------------------------------ DEM（本地高程采样）
_DEM = None
def dem():
    global _DEM
    if _DEM is None:
        raw = open(os.path.join(DATA, 'dem.bin'), 'rb').read()
        import array
        a = array.array('h'); a.frombytes(raw)
        _DEM = (a, 1024, 1024)
    return _DEM

BBOX = (97.6, 25.9, 105.4, 32.5)
def dem_at(lon, lat):
    a, C, R = dem()
    lon0, lat0, lon1, lat1 = BBOX
    x = (lon - lon0) / (lon1 - lon0) * C - .5
    y = (lat1 - lat) / (lat1 - lat0) * R - .5
    x0, y0 = max(0, min(C - 2, int(x))), max(0, min(R - 2, int(y)))
    fx, fy = x - x0, y - y0
    i = y0 * C + x0
    return (a[i] * (1 - fx) * (1 - fy) + a[i + 1] * (1 - fx) * fy +
            a[i + C] * fx * (1 - fy) + a[i + C + 1] * fx * fy)

def slope_at(lon, lat):
    dx = 0.0007; dy = 0.0006
    dzdx = (dem_at(lon + dx, lat) - dem_at(lon - dx, lat)) / (2 * dx * 97400)
    dzdy = (dem_at(lon, lat + dy) - dem_at(lon, lat - dy)) / (2 * dy * 110900)
    return round(math.degrees(math.atan(math.hypot(dzdx, dzdy))), 1)

def http_json(url, timeout=8):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (jinsha)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))

# 允许代理到的大模型域名（防止把本服务当成任意地址的转发器）
LLM_ALLOW = ('api.openai.com', 'api.deepseek.com', 'dashscope.aliyuncs.com',
             'open.bigmodel.cn', 'openrouter.ai', 'api.moonshot.cn',
             'text.pollinations.ai', 'localhost', '127.0.0.1')

def llm_forward(body, timeout=40):
    """把前端的 {url,model,key,messages} 转发到 OpenAI 兼容接口，返回原始 JSON。

    浏览器直连外部模型会被 CORS 拦掉，密钥也会暴露在请求头里；走本机服务转发两件事都解决。
    """
    url = (body.get('url') or '').strip()
    if not url:
        return None, '未配置模型地址'
    host = (urllib.parse.urlparse(url).hostname or '').lower()
    if host not in LLM_ALLOW:
        return None, '不允许的模型地址：%s' % (host or '—')
    payload = {'model': body.get('model') or '', 'messages': body.get('messages') or [],
               'temperature': 0, 'stream': False}
    hdr = {'Content-Type': 'application/json', 'User-Agent': 'JinshaEco/2.0'}
    if body.get('key'):
        hdr['Authorization'] = 'Bearer %s' % body['key']
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=hdr, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8')), None
    except urllib.error.HTTPError as e:
        detail = ''
        try: detail = e.read().decode('utf-8', 'ignore')[:200]
        except Exception: pass
        return None, '模型返回 %d：%s' % (e.code, detail or e.reason)
    except Exception as e:
        return None, '%s：%s' % (type(e).__name__, e)

def enrich(lon, lat):
    """联网时实时补齐土地覆盖（Sentinel-2 10m）"""
    out = {"lc": {}, "lcSrc": "待接入"}
    dy = 5 / 111.0; dx = 5 / (111.0 * math.cos(math.radians(lat)))
    env = json.dumps({"xmin": lon - dx, "ymin": lat - dy, "xmax": lon + dx, "ymax": lat + dy,
                      "spatialReference": {"wkid": 4326}})
    url = ('https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer/'
           'computeHistograms?geometry=%s&geometryType=esriGeometryEnvelope&sr=4326&f=json'
           % urllib.parse.quote(env))
    names = {1: '水体', 2: '林地', 4: '湿地', 5: '农田', 7: '建成区', 8: '裸地', 9: '冰雪', 10: '云', 11: '草地灌丛'}
    try:
        cnt = http_json(url)['histograms'][0]['counts']
        tot = sum(cnt[1:]) or 1
        out['lc'] = {names[i]: round(cnt[i] / tot, 4) for i in range(1, len(cnt)) if i in names and cnt[i] / tot > 0.0008}
        out['lcSrc'] = 'Sentinel-2 10 m LULC · 5 km 缓冲（实时接入）'
    except Exception as e:
        out['lcSrc'] = '离线：土地覆盖待补（%s）' % type(e).__name__
    return out

# ------------------------------------------------------------------ 数据治理（区域级人工修正 / 追加观测）
# 设计原则：stations.json 是「原始观测」，只读不改；人工修正单独落一层「覆盖层 + 变更台账」，
# 派生指标一律读取「有效值」。所以任何一次改动都可追溯、可撤销、可复核，原始数据永远可回溯。
GOV_PATH = os.path.join(DATA, 'governance.json')

FIELD_LIST = [
    {'id': 'elev',        'nm': '海拔',       'unit': 'm',  'grp': '地形',   'frac': False, 'min': 0,   'max': 8000, 'dec': 0},
    {'id': 'slope',       'nm': '坡度',       'unit': '°',  'grp': '地形',   'frac': False, 'min': 0,   'max': 60,   'dec': 1},
    {'id': 'temp',        'nm': '年均温',     'unit': '℃', 'grp': '气候',   'frac': False, 'min': -15, 'max': 35,   'dec': 1},
    {'id': 'precip',      'nm': '年降水',     'unit': 'mm', 'grp': '气候',   'frac': False, 'min': 80,  'max': 4000, 'dec': 0},
    {'id': 'lc.林地',     'nm': '林地占比',   'unit': '%',  'grp': '下垫面', 'frac': True,  'min': 0,   'max': 1,    'dec': 4},
    {'id': 'lc.草地灌丛', 'nm': '草地灌丛',   'unit': '%',  'grp': '下垫面', 'frac': True,  'min': 0,   'max': 1,    'dec': 4},
    {'id': 'lc.农田',     'nm': '农田占比',   'unit': '%',  'grp': '下垫面', 'frac': True,  'min': 0,   'max': 1,    'dec': 4},
    {'id': 'lc.建成区',   'nm': '建成区占比', 'unit': '%',  'grp': '下垫面', 'frac': True,  'min': 0,   'max': 1,    'dec': 4},
    {'id': 'lc.裸地',     'nm': '裸地占比',   'unit': '%',  'grp': '下垫面', 'frac': True,  'min': 0,   'max': 1,    'dec': 4},
    {'id': 'lc.水体',     'nm': '水体占比',   'unit': '%',  'grp': '下垫面', 'frac': True,  'min': 0,   'max': 1,    'dec': 4},
    {'id': 'lc.湿地',     'nm': '湿地占比',   'unit': '%',  'grp': '下垫面', 'frac': True,  'min': 0,   'max': 1,    'dec': 4},
]
FIELD_MAP = {f['id']: f for f in FIELD_LIST}

# 未来：时间维度 / 气象土壤等要素直接往这里加字段即可，覆盖层与台账无需改动
RESERVED_FIELDS = ['soil.有机质', 'soil.全氮', 'met.相对湿度', 'met.风速']

_GOV = None
def gov():
    global _GOV
    if _GOV is None:
        g = load_json(GOV_PATH, None)
        if not isinstance(g, dict): g = {}
        g.setdefault('version', 1)
        g.setdefault('seq', 0)
        g.setdefault('overrides', {})
        g.setdefault('changes', [])
        g.setdefault('observations', [])
        g.setdefault('regions', [])
        _GOV = g
    return _GOV

def gov_save():
    save_json(GOV_PATH, gov())

def ov_of(name):
    return gov()['overrides'].get(name) or {}

def all_stations():
    return load_json(STATIONS, {'stations': []})['stations']

def field_clamp(f, v):
    try: v = float(v)
    except Exception: v = 0.0
    return round(max(f['min'], min(f['max'], v)), f['dec'])

def eff_val(st, fid):
    """站点某字段的「有效值」：人工修正 > 气候再分析均值 > 原始观测。
    指标计算、图表、导出、报告全部走这里，保证界面看到的和算出来的永远一致。"""
    ov = ov_of(st.get('name'))
    if fid in ov:
        try: return float(ov[fid])
        except Exception: pass
    if fid in ('temp', 'precip'):
        cm = clim_mean(st.get('name'))
        if cm:
            try: return float(cm[0] if fid == 'temp' else cm[1])
            except Exception: pass
    if fid.startswith('lc.'):
        try: return float((st.get('lc') or {}).get(fid[3:], 0) or 0)
        except Exception: return 0.0
    try: return float(st.get(fid) or 0)
    except Exception: return 0.0

def eff(st):
    """返回应用过人工修正的站点副本（供导出 / 数据库视图使用）。"""
    out = dict(st)
    out['lc'] = dict(st.get('lc') or {})
    out['_ov'] = sorted(ov_of(st.get('name')).keys())
    for fid in FIELD_MAP:
        if fid.startswith('lc.'):
            if fid in out['_ov']: out['lc'][fid[3:]] = eff_val(st, fid)
        elif fid in out['_ov']:
            out[fid] = eff_val(st, fid)
    if 'temp' in out['_ov']: out['temp'] = eff_val(st, 'temp')
    if 'precip' in out['_ov']: out['precip'] = eff_val(st, 'precip')
    return out

def _hav(a, b):
    dx = (a['lon'] - b['lon']) * 111.0 * math.cos(math.radians((a['lat'] + b['lat']) / 2))
    dy = (a['lat'] - b['lat']) * 111.0
    return math.hypot(dx, dy)

def nearest_mean(sts, target, fid, k=3):
    """空间邻域参照值：最近 k 站按距离反比加权。
    气温按 6.5 ℃/km 直减率先订正到目标站高程再比较，否则「高原站 vs 河谷站」必然假阳性。"""
    ds = sorted(((_hav(target, s), s) for s in sts if s['name'] != target['name']), key=lambda t: t[0])[:k]
    ws = [(1.0 / max(d, 1.0), s) for d, s in ds]
    tw = sum(w for w, _ in ws) or 1.0
    zt = eff_val(target, 'elev')
    def val(s):
        v = eff_val(s, fid)
        return v + 0.0065 * (eff_val(s, 'elev') - zt) if fid == 'temp' else v
    return sum(w * val(s) for w, s in ws) / tw, (ds[0][0] if ds else None)

# ---- 区域定义：全流域 / 三个河段 / 气候地貌分区 / 用户框选的自定义区域
SEG_DEF = [
    ('seg_up',  '上游河段', '岗拖—石鼓，高原峡谷段（经度 < 100.0°E）', lambda s: s['lon'] < 100.0),
    ('seg_mid', '中游河段', '金江街—乌东德，山原峡谷过渡段（100.0–102.8°E）',
     lambda s: 100.0 <= s['lon'] < 102.8),
    ('seg_low', '下游河段', '白鹤滩—向家坝，库区河谷段（≥ 102.8°E）', lambda s: s['lon'] >= 102.8),
]

def region_defs():
    sts = all_stations()
    out = [{'id': 'basin', 'kind': 'basin', 'name': '全流域',
            'desc': '金沙江干流 %d 个监测站全域' % len(sts), 'bbox': None}]
    for rid, nm, desc, pred in SEG_DEF:
        out.append({'id': rid, 'kind': 'seg', 'name': nm, 'desc': desc, 'bbox': None, '_pred': pred})
    for i, z in enumerate(sorted({s.get('zone') or '未分区' for s in sts})):
        out.append({'id': 'zone%d' % i, 'kind': 'zone', 'name': z,
                    'desc': '气候—地貌分区：' + z, 'bbox': None, '_zone': z})
    for r in gov()['regions']:
        out.append({'id': r['id'], 'kind': 'custom', 'name': r['name'],
                    'desc': r.get('note') or '框选的自定义区域', 'bbox': r['bbox']})
    return out

def region_stations(rid):
    sts = all_stations()
    for d in region_defs():
        if d['id'] != rid: continue
        if d['kind'] == 'basin': return sts, d
        if d['kind'] == 'seg':   return [s for s in sts if d['_pred'](s)], d
        if d['kind'] == 'zone':  return [s for s in sts if (s.get('zone') or '未分区') == d['_zone']], d
        if d['kind'] == 'custom':
            x0, y0, x1, y1 = d['bbox']
            return [s for s in sts if x0 <= s['lon'] <= x1 and y0 <= s['lat'] <= y1], d
    return [], None

def region_means(sts):
    """区域聚合：8 维生态服务 + EI / 风险 / 碳密度 / 覆盖度 / EEI。"""
    if not sts: return {}
    n = len(sts)
    items = [eco_item(s) for s in sts]
    ms = [_m(s) for s in sts]
    m = {k: round(sum(i[k] for i in items) / n, 3)
         for k in ('habitat', 'biodiversity', 'water', 'soil', 'climate', 'resilience', 'esv', 'disturbance')}
    m.update({
        'eei': round(sum(i['eei'] for i in items) / n, 1),
        'ei': round(sum(x['ei'] for x in ms) / n, 2),
        'risk': round(sum(x['risk'] for x in ms) / n, 1),
        'carbon': round(sum(x['carbon'] for x in ms) / n, 1),
        'fvc': round(sum(x['fvc'] for x in ms) / n, 3),
        'slide': round(sum(x['slide'] for x in ms) / n, 1),
        'n': n,
    })
    m['grade'] = _grade(m['eei'])
    return m

def region_payload(rid):
    sts, rd = region_stations(rid)
    if not rd: return None, '未找到区域：%s' % rid
    ova = gov()['overrides']
    pst = []
    for s in sts:
        nm = s['name']
        v = {f['id']: round(eff_val(s, f['id']), f['dec']) for f in FIELD_LIST}
        it = eco_item(s); mm = _m(s)
        pst.append({'name': nm, 'zone': s.get('zone', ''), 'lon': s['lon'], 'lat': s['lat'],
                    'type': s.get('type', ''), 'v': v,
                    'edited': sorted((ova.get(nm) or {}).keys()),
                    'eei': it['eei'], 'grade': it['grade'],
                    'ei': round(mm['ei'], 1), 'risk': round(mm['risk'], 1),
                    'carbon': round(mm['carbon'], 1), 'fvc': round(mm['fvc'], 3)})
    names = {p['name'] for p in pst}
    chs = [c for c in gov()['changes'] if c.get('region') == rid][-10:][::-1]
    obs = [o for o in gov()['observations'] if o.get('station') in names][-10:][::-1]
    r = {k: v for k, v in rd.items() if not k.startswith('_')}
    r['count'] = len(pst)
    r['edited'] = sum(1 for p in pst if p['edited'])
    return {'ok': True, 'region': r, 'fields': FIELD_LIST, 'reserved': RESERVED_FIELDS,
            'stations': pst, 'mean': region_means(sts),
            'anomalies': [a for a in anomaly_scan() if a['station'] in names],
            'changes': chs, 'observations': obs, 'govSeq': gov()['seq']}, None

def anomaly_scan(fid=None):
    """数据质量筛查：稳健 Z 分数（中位数 + 1.4826·MAD）+ 空间邻域一致性，双判据同时超阈才提示。
    结论一律是「疑似、待人工复核」，不是「判错」——流域本身空间异质性强（干热河谷 vs 高原草甸），
    纯统计离群不等于数据错误，所以建议值只作参照，采纳与否由人决定。"""
    sts = all_stations()
    # 字段级阈值：zmin 统计离群门槛，relmin 空间不连续门槛（相对邻域参照值）
    RULES = {
        'temp':        {'absdev': 2.5, 'zmin': 99,  'relmin': 9, 'note': '与邻站高程订正后相差 > 2.5 ℃'},
        'precip':      {'zmin': 3.0, 'relmin': 0.15, 'note': '稳健 Z > 3 且邻站偏差 > 15%'},
        'slope':       {'zmin': 3.0, 'relmin': 0.40, 'note': '稳健 Z > 3 且邻站偏差 > 40%'},
        'lc.林地':     {'zmin': 5.0, 'relmin': 0.50, 'note': '稳健 Z > 5 且邻站偏差 > 50%'},
        'lc.草地灌丛': {'zmin': 5.0, 'relmin': 0.50, 'note': '稳健 Z > 5 且邻站偏差 > 50%'},
        'lc.农田':     {'zmin': 5.0, 'relmin': 0.50, 'note': '稳健 Z > 5 且邻站偏差 > 50%'},
    }
    dis = {(d.get('station'), d.get('field')) for d in gov().get('dismissals', [])}
    out = []
    for f in ([fid] if fid else list(RULES)):
        fm, rule = FIELD_MAP.get(f), RULES.get(f)
        if not fm or not rule: continue
        rows = [(s, eff_val(s, f)) for s in sts]
        xs = sorted(v for _, v in rows); n = len(xs)
        if n < 5: continue
        med = xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2
        mad = sorted(abs(v - med) for _, v in rows)[n // 2]
        scale = mad * 1.4826 or (sum(abs(v - med) for _, v in rows) / n) or 1e-9
        for s, v in rows:
            if (s['name'], f) in dis: continue
            nb, dist = nearest_mean(sts, s, f)
            z = (v - med) / scale
            rel = (v - nb) / max(abs(nb), 1e-9)
            if f == 'temp':
                hit = abs(v - nb) >= rule['absdev']
                why = '与邻站高程订正后相差 %.1f ℃' % (v - nb)
            else:
                hit = abs(z) >= rule['zmin'] and abs(rel) >= rule['relmin']
                why = '稳健 Z = %.2f，与 %.0f km 内邻站相差 %+.0f%%' % (z, dist or 0, rel * 100)
            if not hit: continue
            lvl = '高' if (abs(z) >= 4.5 or abs(rel) >= 1.0) else '中'
            out.append({'station': s['name'], 'field': f, 'fieldNm': fm['nm'], 'unit': fm['unit'],
                        'value': round(v, fm['dec']), 'median': round(med, fm['dec']),
                        'z': round(z, 2), 'nbr': round(nb, fm['dec']),
                        'nbrDist': round(dist, 1) if dist else None,
                        'dev': round(rel * 100, 1), 'level': lvl,
                        'suggest': field_clamp(fm, nb), 'rule': rule['note'], 'why': why})
    return sorted(out, key=lambda a: (-(a['level'] == '高'), -abs(a['z'])))

def _rec_change(kind, user, **kw):
    g = gov()
    g['seq'] = int(g.get('seq', 0)) + 1
    rec = {'id': 'C%d' % g['seq'], 't': now(), 'user': user, 'kind': kind}
    rec.update(kw)
    g['changes'].append(rec)
    if len(g['changes']) > 200: del g['changes'][:len(g['changes']) - 200]
    return rec

def _norm_value(f, value, pct):
    """把前端可能按 % 传入的下垫面数值归一到 0–1 分数。
    注意：倍数（scale）绝不能归一，「上调 30%」传的是 1.3，不是 1.3%。"""
    v = float(value)
    if f['frac'] and (pct or abs(v) > 1.0): v = v / 100.0
    return v

def apply_adjust(region_id, fid, op, value, reason, source, user):
    sts, rd = region_stations(region_id)
    if not sts: return None, '该区域内没有站点，无法调整'
    f = FIELD_MAP.get(fid)
    if not f: return None, '未知字段：%s' % fid
    if not (reason or '').strip(): return None, '必须填写修正原因（台账留痕要求）'
    if op not in ('set', 'scale', 'offset'): return None, '不支持的调整方式'
    try:
        val = float(value)
        if op != 'scale': val = _norm_value(f, val, False)   # 倍数不归一
    except Exception:
        return None, '数值格式不正确'
    before = region_means(sts)
    prev, touched = {}, []
    for s in sts:
        nm = s['name']
        old = eff_val(s, fid)
        new = val if op == 'set' else (old * val if op == 'scale' else old + val)
        new = field_clamp(f, new)
        if abs(new - old) < 1e-9: continue
        prev.setdefault(nm, {})[fid] = (ov_of(nm).get(fid))
        gov()['overrides'].setdefault(nm, {})[fid] = new
        touched.append({'name': nm, 'old': round(old, f['dec']), 'new': new})
    if not touched: return None, '调整后数值没有变化（可能已被区间裁剪）'
    after = region_means(sts)
    rec = _rec_change('adjust', user, region=region_id, regionName=rd['name'], field=fid,
                      fieldNm=f['nm'], unit=f['unit'], op=op, value=round(val, 4),
                      reason=reason.strip(), source=source or '人工复核',
                      n=len(touched), prev=prev, items=touched,
                      before={k: before.get(k) for k in ('eei', 'ei', 'risk', 'carbon', 'fvc')},
                      after={k: after.get(k) for k in ('eei', 'ei', 'risk', 'carbon', 'fvc')})
    gov_save()
    audit({'t': now(), 'user': user, 'ip': '-', 'act': '区域调数', 'region': rd['name'],
           'field': f['nm'], 'op': op, 'value': val, 'n': len(touched), 'id': rec['id']})
    return {'ok': True, 'change': rec, 'affected': len(touched), 'items': touched,
            'before': before, 'after': after, 'mean': after}, None

def apply_correct(name, fid, value, reason, source, user):
    sts = all_stations()
    s = next((x for x in sts if x['name'] == name), None)
    if not s: return None, '未找到站点：%s' % name
    f = FIELD_MAP.get(fid)
    if not f: return None, '未知字段：%s' % fid
    if not (reason or '').strip(): return None, '必须填写修正原因（台账留痕要求）'
    old = eff_val(s, fid)
    try: val = field_clamp(f, _norm_value(f, value, False))
    except Exception: return None, '数值格式不正确'
    if abs(val - old) < 1e-9: return None, '数值未变化'
    before = region_means(sts)
    prevv = ov_of(name).get(fid)
    gov()['overrides'].setdefault(name, {})[fid] = val
    after = region_means(sts)
    rec = _rec_change('correct', user, region='station:%s' % name, regionName=name, station=name,
                      field=fid, fieldNm=f['nm'], unit=f['unit'], op='set', value=val,
                      reason=reason.strip(), source=source or '人工修正', n=1,
                      prev={name: {fid: prevv}}, items=[{'name': name, 'old': round(old, f['dec']), 'new': val}],
                      before={k: before.get(k) for k in ('eei', 'ei', 'risk', 'carbon', 'fvc')},
                      after={k: after.get(k) for k in ('eei', 'ei', 'risk', 'carbon', 'fvc')})
    gov_save()
    audit({'t': now(), 'user': user, 'ip': '-', 'act': '单站修正', 'station': name,
           'field': f['nm'], 'old': old, 'new': val, 'id': rec['id']})
    return {'ok': True, 'change': rec, 'old': round(old, f['dec']), 'new': val,
            'before': before, 'after': after}, None

def apply_reset(region_id, fid, user, reason='批量回退为原始观测'):
    sts, rd = region_stations(region_id)
    if not rd: return None, '未找到区域'
    fields = [fid] if fid else list(FIELD_MAP)
    prev, n = {}, 0
    for s in sts:
        nm = s['name']; ov = gov()['overrides'].get(nm)
        if not ov: continue
        for f in fields:
            if f in ov:
                prev.setdefault(nm, {})[f] = ov.pop(f); n += 1
        if not ov: gov()['overrides'].pop(nm, None)
    if not n: return None, '该区域没有需要回退的人工修正'
    rec = _rec_change('reset', user, region=region_id, regionName=rd['name'],
                      field=fid or '全部字段', reason=reason, n=n, prev=prev,
                      before=None, after={k: region_means(sts).get(k) for k in ('eei', 'ei', 'risk', 'carbon', 'fvc')})
    gov_save()
    audit({'t': now(), 'user': user, 'ip': '-', 'act': '区域回退', 'region': rd['name'], 'n': n})
    return {'ok': True, 'change': rec, 'reverted': n, 'mean': region_means(sts)}, None

def undo_change(cid, user):
    g = gov()
    rec = next((r for r in g['changes'] if r['id'] == cid), None)
    if not rec: return None, '未找到变更 %s' % cid
    if rec.get('undone'): return None, '该变更已撤销过'
    prev = rec.get('prev') or {}
    for nm, fields in prev.items():
        ov = g['overrides'].get(nm)
        if ov is None: continue
        for fid, oldv in fields.items():
            if oldv is None: ov.pop(fid, None)
            else: ov[fid] = oldv
        if not ov: g['overrides'].pop(nm, None)
    rec['undone'] = True; rec['undoneAt'] = now(); rec['undoneBy'] = user
    gov_save()
    audit({'t': now(), 'user': user, 'ip': '-', 'act': '撤销变更', 'id': cid})
    return {'ok': True, 'change': rec, 'mean': region_means(all_stations())}, None

def add_observation(name, fid, value, t, source, note, user, apply=True):
    """追加观测：把手工补测 / 其他数据源的数值登记进观测台账，并可选择是否作为当前有效值。"""
    sts = all_stations()
    s = next((x for x in sts if x['name'] == name), None)
    if not s: return None, '未找到站点：%s' % name
    f = FIELD_MAP.get(fid)
    if not f: return None, '未知字段：%s' % fid
    try: val = field_clamp(f, _norm_value(f, value, False))
    except Exception: return None, '数值格式不正确'
    g = gov()
    oid = 'O%d' % (len(g['observations']) + 1)
    rec = {'id': oid, 'station': name, 'field': fid, 'fieldNm': f['nm'], 'unit': f['unit'],
           'value': val, 't': (t or time.strftime('%Y-%m')), 'source': source or '手工录入',
           'note': (note or ''), 'by': user, 'at': now(), 'applied': bool(apply)}
    g['observations'].append(rec)
    out = {'ok': True, 'observation': rec}
    if apply:
        prevv = ov_of(name).get(fid)
        gov()['overrides'].setdefault(name, {})[fid] = val
        ch = _rec_change('observe', user, region='station:%s' % name, regionName=name, station=name,
                         field=fid, fieldNm=f['nm'], unit=f['unit'], op='set', value=val,
                         reason='追加观测（%s）' % rec['source'], source=rec['source'], n=1,
                         prev={name: {fid: prevv}},
                         items=[{'name': name, 'old': round(eff_val(s, fid), f['dec']), 'new': val}])
        rec['changeId'] = ch['id']
        out['change'] = ch
        out['mean'] = region_means(sts)
    gov_save()
    audit({'t': now(), 'user': user, 'ip': '-', 'act': '追加观测', 'station': name,
           'field': f['nm'], 'value': val, 'source': rec['source'], 'applied': bool(apply)})
    return out, None

def dismiss_anomaly(name, fid, reason, user):
    """把某条筛查结论标记为「已人工核查、维持原值」，之后不再重复提示。"""
    if not name or not FIELD_MAP.get(fid): return None, '参数不完整'
    g = gov()
    g.setdefault('dismissals', [])
    if any(d.get('station') == name and d.get('field') == fid for d in g['dismissals']):
        return None, '该条已核查过'
    g['dismissals'].append({'station': name, 'field': fid, 'reason': reason or '经复核维持原值',
                            'by': user, 'at': now()})
    gov_save()
    audit({'t': now(), 'user': user, 'ip': '-', 'act': '异常驳回', 'station': name, 'field': fid})
    return {'ok': True, 'dismissed': {'station': name, 'field': fid}}, None

def add_region(name, bbox, note, user):
    name = (name or '').strip()
    if not name: return None, '区域名称必填'
    try:
        x0, y0, x1, y1 = [float(v) for v in bbox]
    except Exception:
        return None, '区域范围格式不正确'
    x0, x1 = min(x0, x1), max(x0, x1)
    y0, y1 = min(y0, y1), max(y0, y1)
    if x1 - x0 < 0.02 or y1 - y0 < 0.02: return None, '框选范围太小（至少 0.02°）'
    sts = [s for s in all_stations() if x0 <= s['lon'] <= x1 and y0 <= s['lat'] <= y1]
    if not sts: return None, '框选范围内没有监测站，请扩大范围'
    g = gov()
    rid = 'r%d' % int(time.time() * 1000 % 1e9)
    r = {'id': rid, 'name': name, 'bbox': [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)],
         'note': (note or ''), 'by': user, 'at': now()}
    g['regions'].append(r)
    gov_save()
    audit({'t': now(), 'user': user, 'ip': '-', 'act': '新建区域', 'name': name, 'n': len(sts)})
    return {'ok': True, 'region': r, 'count': len(sts)}, None

# ------------------------------------------------------------------ 遥感（GEE）时序数据
# 运行时只读批处理产物 data/gee/*.json：GEE 在云端做云掩膜与分区统计，
# 落到本地的是「20 站 × 月值」的数值表，服务端仍然零依赖、离线可用。
RS_DIR = os.path.join(DATA, 'gee')
_RS_CACHE = {}

def rs_load(name):
    """按 mtime 缓存，批处理重跑后不用重启服务。"""
    fp = os.path.join(RS_DIR, name)
    if not os.path.isfile(fp):
        return None
    mt = os.path.getmtime(fp)
    hit = _RS_CACHE.get(name)
    if hit and hit[0] == mt:
        return hit[1]
    obj = load_json(fp, None)
    _RS_CACHE[name] = (mt, obj)
    return obj

def rs_meta():
    return rs_load('meta.json') or {}

def _sen_mk(vals):
    """与 tools/gee_sync.py 同口径的 Sen 斜率 + Mann-Kendall 检验（纯标准库）。"""
    ys = [v for v in vals if v is not None]
    n = len(ys)
    if n < 5:
        return None
    slopes = sorted((ys[j] - ys[i]) / (j - i) for i in range(n - 1) for j in range(i + 1, n))
    sen = slopes[len(slopes) // 2]
    s = sum((1 if ys[j] > ys[i] else (-1 if ys[j] < ys[i] else 0))
            for i in range(n - 1) for j in range(i + 1, n))
    var = n * (n - 1) * (2 * n + 5) / 18.0
    z = 0.0 if not var else ((s - (1 if s > 0 else -1)) / math.sqrt(var) if s else 0.0)
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    trend = ('显著上升' if (sen > 0 and p < 0.05) else
             '显著下降' if (sen < 0 and p < 0.05) else '无显著趋势')
    return {'sen': round(sen, 5), 'z': round(z, 3), 'p': round(p, 4), 'trend': trend, 'n': n}

def seasonal_mk(by_season):
    """季节化 Mann-Kendall（Hirsch–Slack 简化式，忽略季节间协方差）。

    只在同一日历月内部比较（1 月比 1 月……），避免月度序列的季节起伏被误判为趋势。
    每个季节至少 2 个年份、总共至少 2 个季节，否则不给结论。返回 None 表示样本不足。
    """
    seasons = {k: [float(v) for v in vs if v is not None] for k, vs in (by_season or {}).items()}
    seasons = {k: vs for k, vs in seasons.items() if len(vs) >= 2}
    if len(seasons) < 2:
        return None
    s_total, var_total, denom, n_total = 0, 0.0, 0, 0
    for vs in seasons.values():
        n = len(vs)
        n_total += n
        denom += n * (n - 1) // 2
        for i in range(n - 1):
            for j in range(i + 1, n):
                s_total += (1 if vs[j] > vs[i] else (-1 if vs[j] < vs[i] else 0))
        var_g = n * (n - 1) * (2 * n + 5)
        counts = {}
        for v in vs:
            counts[v] = counts.get(v, 0) + 1
        for t in counts.values():
            if t > 1:
                var_g -= t * (t - 1) * (2 * t + 5)
        var_total += var_g / 18.0
    if denom <= 0:
        return None
    tau = s_total / denom
    if var_total <= 0:
        return {'n': n_total, 'seasons': len(seasons), 'S': s_total, 'tau': 0.0,
                'z': 0.0, 'p': 1.0, 'trend': '无显著趋势', 'method': 'seasonal'}
    z = ((s_total - 1) / math.sqrt(var_total)) if s_total > 0 else \
        ((s_total + 1) / math.sqrt(var_total)) if s_total < 0 else 0.0
    p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
    trend = ('显著上升' if (p < 0.05 and s_total > 0) else
             '显著下降' if (p < 0.05 and s_total < 0) else '无显著趋势')
    return {'n': n_total, 'seasons': len(seasons), 'S': s_total, 'tau': round(tau, 3),
            'z': round(z, 3), 'p': round(p, 4), 'trend': trend, 'method': 'seasonal'}

def tennant_baseline(rows):
    """从 hydro_monthly（GloFAS 月径流）按站构建季节化生态流量基准（各月 Q50）。

    行结构：station / year / month / discharge_m3s / ...。输出每站 12 个月的
    mean / median(Q50) / q20 / q80 / min / max / n。这是生态流量参照，非保证率真值。
    """
    from collections import OrderedDict
    st = OrderedDict()
    for r in rows:
        if r.get('discharge_m3s') in (None, ''):
            continue
        try:
            q = float(r['discharge_m3s']); m = int(r['month']); nm = r.get('station') or r.get('站点')
        except (ValueError, TypeError):
            continue
        if m < 1 or m > 12 or nm is None:
            continue
        st.setdefault(nm, {i: [] for i in range(1, 13)})[m].append(q)
    out = []
    for nm, months in st.items():
        entry = {'station': nm, 'months': {}}
        for m in range(1, 13):
            vs = sorted(months.get(m, []))
            if not vs:
                entry['months']['%02d' % m] = {'n': 0}
                continue
            n = len(vs)
            def q(x):
                return vs[min(n - 1, max(0, int(round(x * (n - 1)))))]
            entry['months']['%02d' % m] = {
                'n': n, 'mean': round(sum(vs) / n, 1), 'median': round(q(0.5), 1),
                'q20': round(q(0.2), 1), 'q80': round(q(0.8), 1),
                'min': round(vs[0], 1), 'max': round(vs[-1], 1)}
        out.append(entry)
    return out

def _hav_km(a, b):
    """两点球面距离（km），a/b 为 [lon, lat]。"""
    lon1, lat1, lon2, lat2 = a[0], a[1], b[0], b[1]
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

def _mean_nn_dist(poly_a, poly_b, step=25):
    """两条折线间的平均最近邻距离（km）。抽样降低复杂度。"""
    if not poly_a or not poly_b:
        return None
    sa = poly_a[::step] or poly_a[:1]
    sb = poly_b[::step] or poly_b[:1]
    ds = []
    for p in sa:
        ds.append(min(_hav_km(p, q) for q in sb))
    return sum(ds) / len(ds)

def river_compare():
    """河网交叉验证：DEM D8 派生（hydro.json） vs Natural Earth 10m（reference/river_naturalearth.json）。"""
    hydro = load_json(os.path.join(DATA, 'hydro.json'), {})
    ref = load_json(os.path.join(DATA, 'reference', 'river_naturalearth.json'), {})
    rivers = (hydro or {}).get('rivers') or []
    main_mine = None
    for r in rivers:
        if r.get('lvl') == 1:
            main_mine = r
            break
    main_ref = (ref or {}).get('main')
    meta = (hydro or {}).get('meta') or {}
    out = {
        'mine': {
            'source': meta.get('note', 'DEM D8 派生河网'),
            'main_len_km': (main_mine or {}).get('len'),
            'main_points': len((main_mine or {}).get('p') or []),
            'tributaries': meta.get('nTrib'),
            'src_lines': meta.get('srcLines'),
        },
        'reference': {
            'source': (ref or {}).get('source', 'Natural Earth 10m 河网'),
            'main_len_km': (ref or {}).get('length_km'),
            'main_points': len(main_ref or []),
        },
    }
    mine_p = (main_mine or {}).get('p')
    if mine_p and main_ref:
        d = _mean_nn_dist(mine_p, main_ref)
        # 主河道平均最近邻距离口径：< 10 km 一致，10–25 km 接近，> 25 km 偏离
        status = '一致' if d <= 10 else ('接近' if d <= 25 else '偏离')
        out['agreement'] = {'mean_nn_km': round(d, 2), 'status': status,
                            'method': '主河道抽样点对另一河网的平均最近邻距离（球面距离）'}
    else:
        out['agreement'] = None
    out['note'] = 'DEM D8 派生主河道覆盖 98–105°E 段，Natural Earth 主河含通天河上游（92.99°E 起），' \
                   '长度口径不同，交叉验证仅看空间走向一致性，不用于长度替换。'
    return out

# ------------------------------------------------------------------ 证据级别（A/B/C/D）
# 每一行都要经得起追问：这个数是什么、从哪来、有没有被独立数据检验过。
# A 实测（站点观测）／B 模型（再分析或物理/统计模型，可复算）／C 遥感（卫星反演）／D 代理（无验证的经验系数）
EVIDENCE = [
    {'ind': '站点位置与海拔', 'lv': 'A', 'src': '水文站/梯级电站公开资料', 'basis': '实测坐标与高程，WGS-84', 'check': '与公开资料逐站核对'},
    {'ind': '气温', 'lv': 'B', 'src': 'NASA POWER（MERRA-2）', 'basis': '再分析，按 6.5 ℃/km 订正到站点高程', 'check': '与 ERA5-Land 交叉比对 r=0.86'},
    {'ind': '降水', 'lv': 'B', 'src': 'NASA POWER（MERRA-2）', 'basis': '再分析年降水序列', 'check': '与 GPM IMERG 比对 r=0.89（IMERG 山区高估约 40%）'},
    {'ind': '蒸散', 'lv': 'B', 'src': 'ERA5-Land 月值', 'basis': '再分析，格点原始值', 'check': '尚未独立验证'},
    {'ind': '地表温度', 'lv': 'C', 'src': 'MODIS MOD11A2 1 km', 'basis': '热红外反演，8 天合成后月平均', 'check': '未与地面站比对'},
    {'ind': 'NDVI / EVI', 'lv': 'C', 'src': 'MODIS MOD13Q1 250 m', 'basis': '红光/近红外反演，16 天合成', 'check': '已做 Sen+MK 趋势检验（n=11 年）'},
    {'ind': '树冠覆盖', 'lv': 'C', 'src': 'Hansen 全球森林变化 30 m', 'basis': 'treecover2000 冠层覆盖百分比', 'check': '与 LULC 林地占比一致性检查'},
    {'ind': '植被覆盖 FVC', 'lv': 'D', 'src': '下垫面比例合成', 'basis': '按 LULC 类型加权，非像元二分模型', 'check': '待用 NDVI 二分模型替换'},
    {'ind': '滑坡敏感性', 'lv': 'D', 'src': '坡度·起伏·降水·植被线性加权', 'basis': '经验权重，无量纲 0–1', 'check': '无滑坡编目，未做 ROC 验证'},
    {'ind': '碳密度', 'lv': 'D', 'src': '树冠覆盖 × 类型系数', 'basis': '文献系数（52/7.5/5.2 t·ha⁻¹）', 'check': '无样地实测，未做异速方程核算'},
    {'ind': '水源涵养', 'lv': 'D', 'src': 'P×(0.5+0.42·f)', 'basis': '经验拟合式，非 Budyko 水热耦合', 'check': '无径流站数据率定'},
    {'ind': '土壤保持', 'lv': 'D', 'src': '10+40f−0.2·坡', 'basis': '经验拟合式，非 RUSLE 五因子', 'check': '无泥沙观测验证'},
    {'ind': '生境质量', 'lv': 'D', 'src': '土地覆盖结构代理', 'basis': '按类型赋值 + 邻域衰减', 'check': '无生物调查，代理指标'},
    {'ind': '生物多样性', 'lv': 'D', 'src': '土地覆盖结构代理', 'basis': '与生境质量同源，非物种调查', 'check': '无红外相机/样线数据'},
    {'ind': '综合风险 R', 'lv': 'B', 'src': '滑坡 0.42 + 退化 0.33 + 胁迫 0.25', 'basis': '加权合成，0–100', 'check': '权重 ±25% 蒙特卡洛传播，区间 ±0.2'},
    {'ind': '综合指数 EEI', 'lv': 'B', 'src': '八项生态服务加权', 'basis': 'HJ 192—2015 框架派生', 'check': '权重 ±25% 蒙特卡洛传播，区间 ±0.5'},
]

def evidence_summary():
    cnt = {'A': 0, 'B': 0, 'C': 0, 'D': 0}
    for e in EVIDENCE:
        cnt[e['lv']] += 1
    lab = {'A': '实测', 'B': '模型/再分析', 'C': '遥感反演', 'D': '代理/经验'}
    return {'ok': True, 'items': EVIDENCE, 'count': cnt,
            'labels': lab, 'total': len(EVIDENCE),
            'note': 'A 站点实测｜B 可复算的模型或再分析｜C 卫星反演｜D 无验证的经验系数或结构代理。'
                    'D 级不代表错，代表"还没有真值校验"，论文中须标注。'}

# ------------------------------------------------------------------ 复现包
def _climate_refresh():
    """NASA POWER 月值→年值（纯标准库，随 exe 一起跑）。后台线程调用，不阻塞启动。"""
    try:
        db = load_json(STATIONS, {'stations': []})
        sts = db.get('stations', [])
        if not sts:
            return {'ok': False, 'error': '无站点数据'}
        end = time.localtime().tm_year
        years = list(range(2000, end + 1))
        params = 'T2M,PRECTOTCORR,EVLAND'
        lapse = 6.5
        cachef = os.path.join(DATA, '.power_cache.json')
        cache = load_json(cachef, {}) if os.path.exists(cachef) else {}
        result, basin = {}, {}
        for s in sts:
            key = "%s_%s" % (s['name'], '2000-%d' % end)
            if key in cache:
                d = cache[key]
            else:
                q = urllib.parse.urlencode({'parameters': params, 'community': 'AG',
                    'longitude': round(float(s['lon']), 3), 'latitude': round(float(s['lat']), 3),
                    'start': 2000, 'end': end, 'format': 'JSON'})
                req = urllib.request.Request('https://power.larc.nasa.gov/api/temporal/monthly/point?' + q,
                                             headers={'User-Agent': 'JinshaEco/2.0 (research)'})
                with urllib.request.urlopen(req, timeout=60) as r:
                    d = json.loads(r.read().decode('utf-8'))
                cache[key] = d
                save_json(cachef, cache)
                time.sleep(1.2)
            p = d['properties']['parameter']
            gz = float(d['geometry']['coordinates'][2] or 0)
            se = float(s.get('elev') or gz)
            corr = round(lapse * (gz - se) / 1000.0, 2)
            def annualize(param):
                out = {}
                for y in years:
                    vals, tot, ok = [], 0.0, True
                    for m in range(1, 13):
                        v = param.get('%d%02d' % (y, m))
                        if v is None or v <= -998:
                            ok = False; break
                        vals.append(v); tot += v * calendar.monthrange(y, m)[1]
                    if ok and vals:
                        out[y] = (sum(vals) / len(vals), tot)
                return out
            t = annualize(p['T2M']); pr = annualize(p['PRECTOTCORR']); et = annualize(p['EVLAND'])
            rows = [[y, round(t[y][0] + corr, 2), round(pr[y][1], 1), round(et[y][1], 1)]
                    for y in years if y in t and y in pr and y in et]
            result[s['name']] = {'lon': s['lon'], 'lat': s['lat'], 'elev': s.get('elev'),
                                 'gridElev': round(gz), 'lapseCorr': corr, 'years': rows}
            for y, tt, pp, ee in rows:
                a = basin.setdefault(y, [0.0, 0.0, 0.0, 0]); a[0] += tt; a[1] += pp; a[2] += ee; a[3] += 1
        bseries = [[y, round(v[0] / v[3], 2), round(v[1] / v[3], 1), round(v[2] / v[3], 1)]
                   for y, v in sorted(basin.items()) if v[3]]
        out = {'source': 'NASA POWER · MERRA-2 再分析',
               'params': {'T2M': '℃', 'PRECTOTCORR': 'mm/day', 'EVLAND': 'mm/day'},
               'note': ('月值聚合为年值：温度取 12 月均值，降水/蒸散按月天数累加；'
                        '气温按 %.1f ℃/km 从格点高程订正到站点高程' % lapse),
               'lapse': lapse, 'period': [2000, end],
               'fetched': time.strftime('%Y-%m-%d %H:%M'), 'stations': result, 'basin': bseries}
        save_json(os.path.join(DATA, 'climate.json'), out)
        return {'ok': True, 'stations': len(result), 'years': len(bseries)}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def _auto_sync_start():
    """启动时后台自动同步：climate.json 缺失或超过 30 天 → 拉最新气候年值。"""
    try:
        cf = os.path.join(DATA, 'climate.json')
        stale = True
        if os.path.exists(cf):
            try:
                m = json.load(open(cf, encoding='utf-8'))
                ft = m.get('fetched', '')
                if ft:
                    tt = time.mktime(time.strptime(ft, '%Y-%m-%d %H:%M'))
                    stale = (time.time() - tt) > 30 * 86400
            except Exception:
                pass
        if stale:
            threading.Thread(target=_climate_refresh, daemon=True).start()
    except Exception:
        pass


def _sha256_file(fp):
    try:
        h = hashlib.sha256()
        with open(fp, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None

def repro_pack():
    """一键导出"复现包"：数据指纹 + 全部参数 + 结果快照，带 SHA-256 自校验。

    目的不是好看，而是让别人（或三个月后的自己）能在不问你任何问题的情况下，
    复算出同一组 EEI。这是论文附录最该有的一件东西。
    """
    its = [eco_item(x) for x in all_stations()]
    files = []
    for rel in ('stations.json', 'climate.json', 'governance.json',
                'gee/meta.json', 'gee/annual.json', 'gee/series.json', 'validate.json'):
        fp = os.path.join(DATA, rel)
        if os.path.isfile(fp):
            files.append({'file': rel, 'bytes': os.path.getsize(fp), 'sha256': _sha256_file(fp)})
    snap = [{'name': i['name'], 'zone': i['zone'], 'eei': i['eei'], 'grade': i['grade'],
             'habitat': i['habitat'], 'biodiversity': i['biodiversity'], 'water': i['water'],
             'soil': i['soil'], 'climate': i['climate'], 'resilience': i['resilience'],
             'esv': i['esv'], 'disturbance': i['disturbance']} for i in its]
    blob = json.dumps(snap, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    run_id = hashlib.sha256(blob.encode('utf-8')).hexdigest()[:12]
    return {'ok': True, 'run': run_id, 'engine': 'jinsha-eco 2.0',
            'generated': now(), 'dataToken': data_version()['token'],
            'method': {
                'eei': '8 维加权：生境18 生物多样性15 水源14 土壤12 气候12 韧性11 服务价值10 低干扰8',
                'risk': '滑坡 0.42 + 退化 0.33 + 土地胁迫 0.25',
                'fvc_note': 'FVC 由下垫面比例加权（结构性口径），非 NDVI 像元二分模型',
                'trend': 'NDVI 年值 Sen 斜率 + Mann-Kendall 检验（p<0.05 判显著）',
                'uncertainty': '权重 ±25% 蒙特卡洛 600 次，种子 20261116',
            },
            'thresholds': {'高风险': 58, '中风险': 45, '显著退化': -0.0008,
                           'RSEI': None, '等级': 'A≥75 B≥65 C≥55 D<55'},
            'files': files, 'n': len(snap), 'snapshot': snap,
            'sha256_snapshot': hashlib.sha256(blob.encode('utf-8')).hexdigest(),
            'note': '快照 sha256 由 snapshot 数组按 key 排序、紧凑序列化后计算；'
                    '任何人拿本文件重跑同一引擎应得到同一 run id。'}

# ------------------------------------------------------------------ 指标体检（共线性 + 客观赋权）
EEI_DIMS = [('habitat', '生境质量', 18, lambda it: it['habitat']),
            ('biodiversity', '生物多样性', 15, lambda it: it['biodiversity']),
            ('water', '水源涵养', 14, lambda it: it['water'] / 1000.0),
            ('soil', '土壤保持', 12, lambda it: it['soil'] / 40.0),
            ('climate', '气候调节', 12, lambda it: it['climate']),
            ('resilience', '生态韧性', 11, lambda it: it['resilience']),
            ('esv', '服务价值', 10, lambda it: it['esv'] / 4.0),
            ('less_dist', '低干扰', 8, lambda it: 1 - it['disturbance'])]

def _zcols(rows):
    k = len(rows[0])
    out = [[0.0] * k for _ in rows]
    for j in range(k):
        col = [r[j] for r in rows]
        m = sum(col) / len(col)
        sd = math.sqrt(sum((v - m) ** 2 for v in col) / max(1, len(col) - 1)) or 1e-9
        for i in range(len(rows)):
            out[i][j] = (rows[i][j] - m) / sd
    return out

def _pearson(a, b):
    n = len(a); ma = sum(a) / n; mb = sum(b) / n
    num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return num / den if den else 0.0

def _ranks(v):
    order = sorted(range(len(v)), key=lambda i: v[i])
    r = [0.0] * len(v)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and abs(v[order[j + 1]] - v[order[i]]) < 1e-12:
            j += 1
        avg = (i + j) / 2.0 + 1
        for t in range(i, j + 1):
            r[order[t]] = avg
        i = j + 1
    return r

def diagnose():
    """指标体检：一是查共线性（8 个维度是不是在重复说同一件事），
    二是用 PCA 第一主成分做一次**客观赋权**，与主观权重对照。

    这不是为了推翻主观权重，而是回答"权重换个合理定法，结论会不会变"。
    """
    its = [eco_item(x) for x in all_stations()]
    n = len(its)
    if n < 5:
        return {'ok': False, 'error': '站点不足，无法诊断'}
    keys = [d[0] for d in EEI_DIMS]
    X = [[d[3](it) for d in EEI_DIMS] for it in its]
    Z = _zcols(X)
    k = len(keys)

    # 相关矩阵
    corr = [[round(_pearson([r[i] for r in X], [r[j] for r in X]), 3) for j in range(k)] for i in range(k)]

    # 幂迭代求相关矩阵第一主成分
    v = [1.0 / math.sqrt(k)] * k
    for _ in range(300):
        w = [sum(corr[i][j] * v[j] for j in range(k)) for i in range(k)]
        nv = math.sqrt(sum(x * x for x in w)) or 1e-9
        v = [x / nv for x in w]
    lam = sum(v[i] * sum(corr[i][j] * v[j] for j in range(k)) for i in range(k))
    explained = lam / k
    # 方向对齐：若载荷为负，说明该维度与综合方向相反，取绝对值参与定权并标注
    absv = [abs(x) for x in v]
    sw = sum(absv) or 1e-9
    obj = [x / sw * 100 for x in absv]

    subj = [d[2] for d in EEI_DIMS]
    dims = []
    for i in range(k):
        dims.append({'key': keys[i], 'nm': EEI_DIMS[i][1],
                     'subj': subj[i], 'obj': round(obj[i], 1),
                     'load': round(v[i], 3), 'delta': round(obj[i] - subj[i], 1)})

    # 客观权重下的 EEI 与排名变化
    eei_obj = [sum(obj[i] * X[r][i] for i in range(k)) for r in range(n)]
    eei_sub = [its[r]['eei'] for r in range(n)]
    rs = _pearson(_ranks(eei_sub), _ranks(eei_obj))
    rk_s = _ranks(eei_sub); rk_o = _ranks(eei_obj)
    shifts = sorted(({'name': its[i]['name'], 'subjRank': int(n + 1 - rk_s[i]),
                      'objRank': int(n + 1 - rk_o[i]), 'delta': int(rk_o[i] - rk_s[i])}
                     for i in range(n)), key=lambda x: -abs(x['delta']))

    # 与外部实测（NDVI 年值均值、Hansen 树冠）的相关
    ann = (rs_load('annual.json') or {}).get('ndvi') or {}
    tcc = rs_tcc_map()
    nd = [sum(v for _, v in ann.get(it['name'], [])) / max(1, len(ann.get(it['name'], [])))
          if ann.get(it['name']) else None for it in its]
    ext = []
    for nm, arr in (('NDVI 年值均值（MODIS 实测）', nd),
                    ('树冠覆盖（Hansen 30 m）', [tcc.get(it['name']) for it in its])):
        p = [(eei_sub[i], arr[i]) for i in range(n) if arr[i] is not None]
        if len(p) >= 5:
            ext.append({'nm': nm, 'r': round(_pearson([x for x, _ in p], [y for _, y in p]), 3), 'n': len(p)})

    # 有效观测覆盖（NDVI 月值中有效月份占比）
    ser = (rs_load('series.json') or {}).get('ndvi') or {}
    cov = []
    for it in its:
        arr = ser.get(it['name']) or []
        if not arr:
            continue
        ok = sum(1 for _, v, q in arr if v is not None)
        cov.append({'name': it['name'], 'ratio': round(ok / len(arr), 3), 'months': len(arr)})
    cov.sort(key=lambda x: x['ratio'])

    # 最严重的共线对（去掉对角线）
    pairs = []
    for i in range(k):
        for j in range(i + 1, k):
            if abs(corr[i][j]) >= 0.7:
                pairs.append({'a': EEI_DIMS[i][1], 'b': EEI_DIMS[j][1], 'r': corr[i][j]})
    pairs.sort(key=lambda x: -abs(x['r']))

    nshift = sum(1 for x in shifts if abs(x['delta']) >= 3)
    verdict = ('PCA 第一主成分解释 %.0f%% 的信息；客观权重与主观权重的 EEI 排序一致性 ρ=%.2f，'
               '排名变动 ≥3 位的站 %d 个。' % (explained * 100, rs, nshift))
    if ext:
        verdict += ' 综合指数与 %s 的相关 r=%.2f。' % (ext[0]['nm'].split('（')[0], ext[0]['r'])
    return {'ok': True, 'generated': now(), 'n': n,
            'explained': round(explained, 3), 'spearman': round(rs, 3),
            'dims': dims, 'corr': corr, 'keys': keys,
            'pairs': pairs[:5], 'external': ext, 'shifts': shifts[:6],
            'coverage': {'min': cov[0] if cov else None,
                         'mean': round(sum(c['ratio'] for c in cov) / len(cov), 3) if cov else None,
                         'n': len(cov)},
            'verdict': verdict,
            'note': '客观权重来自 20 站指标矩阵的 PCA 第一主成分载荷（取绝对值归一），'
                    '只用于对照，不替换主观权重；两者排序一致即说明结论对权重不敏感。'}

# ------------------------------------------------------------------ 流域态势结论
def conclusion():
    """把已有指标汇成一段可引用、可答辩的结论。所有数字都来自库内真实计算。"""
    sts = all_stations()
    if not sts:
        return {'ok': False, 'error': '无站点数据'}
    ms = [_m(x) for x in sts]
    its = [eco_item(x) for x in sts]
    n = len(sts)
    eei = sum(i['eei'] for i in its) / n
    risk = sum(m['risk'] for m in ms) / n
    grade = _grade(eei)
    segs = {}
    for seg_id, nm in (('seg_up', '上游高寒峡谷'), ('seg_mid', '中游山原峡谷'), ('seg_low', '下游库区河谷')):
        sub, _ = region_stations(seg_id)
        if sub:
            segs[nm] = {'eei': round(region_means(sub)['eei'], 1),
                        'risk': round(region_means(sub)['risk'], 1), 'n': len(sub)}
    tr = rs_trend_map()
    down = [x for x in tr.items() if x[1]['sen'] < -0.0008 and '下降' in x[1]['trend']]
    up = [x for x in tr.items() if x[1]['sen'] > 0.0008 and '上升' in x[1]['trend']]
    down.sort(key=lambda x: x[1]['sen'])
    plan = patrol_plan(4)['items']
    high = sum(1 for m in ms if m['risk'] >= 58)
    worst = min(segs.items(), key=lambda kv: kv[1]['eei']) if segs else None
    best = max(segs.items(), key=lambda kv: kv[1]['eei']) if segs else None
    txt = ('流域生态环境综合指数 EEI %.1f（%s 级），综合风险 %.1f，高风险站 %d 个。'
           % (eei, grade, risk, high))
    if best and worst:
        txt += ('%s最稳（EEI %.1f），%s最弱（EEI %.1f），空间差异 %.1f 分。'
                % (best[0], best[1]['eei'], worst[0], worst[1]['eei'],
                   best[1]['eei'] - worst[1]['eei']))
    if down:
        txt += ('%d 个站 NDVI 显著下降（%s 等），%d 个站显著改善；植被退化主要发生在干热河谷与库区周边。'
                % (len(down), '、'.join(x[0] for x in down[:4]), len(up)))
    if plan:
        txt += ('建议优先核查 %s。' % '、'.join('%s（%.2f）' % (p0['name'], p0['score']) for p0 in plan[:3]))
    # 气候—地貌分区聚合：回答"20 个点怎么代表 47 万 km²"的第一步（点 → 分区）
    zones = []
    for d0 in region_defs():
        if d0['kind'] != 'zone':
            continue
        sub, _ = region_stations(d0['id'])
        if not sub:
            continue
        zm = region_means(sub)
        zones.append({'name': d0['name'], 'n': len(sub),
                      'eei': round(zm['eei'], 1), 'risk': round(zm['risk'], 1),
                      'fvc': round(zm['fvc'], 3), 'carbon': round(zm['carbon'], 1),
                      'grade': _grade(zm['eei'])})
    zones.sort(key=lambda z: -z['eei'])
    # 小样本分区（n<3）不单独出结论：按"上游/中游/下游"合并，避免用单站代表一个区
    big = [z for z in zones if z['n'] >= 3]
    small = [z for z in zones if z['n'] < 3]
    buckets = {}
    for z in small:
        key = z['name'][:2] if z['name'][:2] in ('上游', '中游', '下游') else '其他'
        b = buckets.setdefault(key, {'name': key + '（合并）', 'n': 0, '_e': 0.0, '_r': 0.0})
        b['n'] += z['n']; b['_e'] += z['eei'] * z['n']; b['_r'] += z['risk'] * z['n']
    for b in buckets.values():
        b['eei'] = round(b.pop('_e') / b['n'], 1)
        b['risk'] = round(b.pop('_r') / b['n'], 1)
        b['grade'] = _grade(b['eei'])
        b['merged'] = True
    zones_min3 = sorted(big + list(buckets.values()), key=lambda z: -z['eei'])
    ev = evidence_summary()
    return {'ok': True, 'generated': now(), 'text': txt,
            'kpi': {'eei': round(eei, 1), 'grade': grade, 'risk': round(risk, 1),
                    'high': high, 'declining': len(down), 'improving': len(up)},
            'segments': segs, 'zones': zones, 'zones_min3': zones_min3,
            'declining': [{'name': k, 'sen': v['sen']} for k, v in down],
            'priority': [{'name': p0['name'], 'score': p0['score'], 'reasons': p0['reasons'],
                          'risk': p0['risk'], 'ndviSen': p0['ndviSen']} for p0 in plan],
            'confidence': ev['count'], 'evidence': ev['items'],
            'dataToken': data_version()['token']}

# ------------------------------------------------------------------ 巡检建议（真实数据驱动）
def patrol_plan(top=6):
    """按"当前该先查哪几段"排序，全部由库里真实指标算出，不含任何人工硬编码状态。

    依据三项，权重可解释：
      综合风险 R（0–100，越高越急）        0.55
      NDVI 年值 Sen 斜率（显著下降才算）    0.28
      待复核异常条数（区域治理的筛查结果）  0.17
    """
    sts = all_stations()
    tr = rs_trend_map()
    cnt = {}
    for a in anomaly_scan():
        cnt[a['station']] = cnt.get(a['station'], 0) + 1
    rows = []
    for st in sts:
        m, nm = _m(st), st['name']
        t = tr.get(nm) or {}
        sen = t.get('sen') or 0.0
        falling = (sen < -0.0008) and ('下降' in str(t.get('trend', '')))
        dec = min(1.0, max(0.0, -sen) * 380) if falling else 0.0
        ac = cnt.get(nm, 0)
        score = 0.55 * (m['risk'] / 100.0) + 0.28 * dec + 0.17 * min(1.0, ac / 2.0)
        why = []
        if m['risk'] >= 58: why.append('综合风险 %.0f（高）' % m['risk'])
        elif m['risk'] >= 45: why.append('综合风险 %.0f（中）' % m['risk'])
        if falling: why.append('NDVI %.4f/年，显著下降' % sen)
        if ac: why.append('%d 项数据待复核' % ac)
        if len(why) == 0: why.append('常规监测（风险与趋势均不突出）')
        rows.append({'name': nm, 'zone': st.get('zone', ''), 'lon': st['lon'], 'lat': st['lat'],
                     'risk': round(m['risk'], 1), 'slide': round(m['slide'], 1),
                     'fvc': round(m['fvc'], 3), 'ndviSen': round(sen, 5),
                     'trend': t.get('trend'), 'anomalies': ac,
                     'score': round(score, 4), 'level': '高' if score >= 0.55 else ('中' if score >= 0.42 else '低'),
                     'reasons': why})
    rows.sort(key=lambda r: -r['score'])
    for i, r in enumerate(rows):
        r['rank'] = i + 1
    return {'ok': True, 'generated': now(), 'dataToken': data_version()['token'],
            'radius_km': 1, 'total': len(rows), 'items': rows[:top],
            'watch': [r for r in rows if r['level'] == '高'][:top],
            'note': '建议由「综合风险 0.55 + NDVI 趋势 0.28 + 待复核异常 0.17」加权得出，'
                    '输入为库内真实指标；这是"该去查哪里"的建议，不是已完成的巡检记录。'}

# ------------------------------------------------------------------ GEE 派生指标
_RS_TREND = None
_RS_TCC = None

def rs_trend_map():
    """每站 NDVI 年值的 Sen 斜率与 MK 显著性（由 data/gee/annual.json 现算，不读库）。"""
    global _RS_TREND
    if _RS_TREND is not None:
        return _RS_TREND
    ann = (rs_load('annual.json') or {}).get('ndvi') or {}
    out = {}
    for nm, arr in ann.items():
        r = _sen_mk([v for _, v in arr])
        if r:
            out[nm] = r
    _RS_TREND = out
    return out

def rs_tcc_map():
    """Hansen 30 m 树冠覆盖（%，静态）。"""
    global _RS_TCC
    if _RS_TCC is not None:
        return _RS_TCC
    ser = (rs_load('series.json') or {}).get('tcc30') or {}
    out = {}
    for nm, arr in ser.items():
        vals = [v for _, v, q in arr if v is not None]
        if vals:
            out[nm] = vals[0]
    _RS_TCC = out
    return out

# ------------------------------------------------------------------ 不确定性（权重传播）
def _pct(v, p):
    v = sorted(v); k = (len(v) - 1) * p / 100.0
    i = int(k)
    return v[i] if i + 1 >= len(v) else v[i] + (v[i + 1] - v[i]) * (k - i)

def uncertainty(draws=600, jitter=0.25):
    """Monte Carlo：只扰动"权重"这一类主观参数（风险三项权重、EEI 八项权重），
    系数与输入数据不动——所以区间读作"权重若在 ±25% 内摆动，结论会落在哪"。
    固定随机种子，任何人重算得到同一组数，可写进论文。"""
    sts = all_stations()
    if not sts:
        return {'ok': False, 'error': '无站点数据'}
    ms = [_m(x) for x in sts]
    its = [eco_item(x) for x in sts]
    base_w = [0.42, 0.33, 0.25]
    eei_w = [18, 15, 14, 12, 12, 11, 10, 8]
    rng = random.Random(20261116)
    risk_draw, eei_draw, ei_draw = [], [], []
    per = {x['name']: {'risk': [], 'eei': []} for x in sts}
    for _ in range(draws):
        wr = [max(0.05, w * (1 + rng.uniform(-jitter, jitter))) for w in base_w]
        tr = sum(wr); wr = [w / tr for w in wr]
        we = [max(1, w * (1 + rng.uniform(-jitter, jitter))) for w in eei_w]
        te = sum(we)
        rs, es = [], []
        for k, m in enumerate(ms):
            r = wr[0] * m['slide'] + wr[1] * m['deg'] + wr[2] * m['lsi']
            it = its[k]
            e = (we[0] * it['habitat'] + we[1] * it['biodiversity'] + we[2] * (it['water'] / 1000)
                 + we[3] * (it['soil'] / 40) + we[4] * it['climate'] + we[5] * it['resilience']
                 + we[6] * (it['esv'] / 4) + we[7] * (1 - it['disturbance'])) / te * 100
            rs.append(r); es.append(e)
            per[sts[k]['name']]['risk'].append(r); per[sts[k]['name']]['eei'].append(e)
        risk_draw.append(sum(rs) / len(rs)); eei_draw.append(sum(es) / len(es))
    base_risk = sum(m['risk'] for m in ms) / len(ms)
    base_eei = sum(i['eei'] for i in its) / len(its)
    items = []
    for nm, d in per.items():
        items.append({'name': nm,
                      'risk': [round(_pct(d['risk'], 5), 1), round(_pct(d['risk'], 50), 1), round(_pct(d['risk'], 95), 1)],
                      'eei': [round(_pct(d['eei'], 5), 1), round(_pct(d['eei'], 50), 1), round(_pct(d['eei'], 95), 1)]})
    return {'ok': True, 'draws': draws, 'jitter': jitter, 'seed': 20261116,
            'note': '只扰动权重（风险三项 ±25%、EEI 八项 ±25%）；输入数据与系数固定，固定种子可复现',
            'basin': {'risk': {'base': round(base_risk, 1), 'lo': round(_pct(risk_draw, 5), 1),
                               'mid': round(_pct(risk_draw, 50), 1), 'hi': round(_pct(risk_draw, 95), 1)},
                      'eei': {'base': round(base_eei, 1), 'lo': round(_pct(eei_draw, 5), 1),
                              'mid': round(_pct(eei_draw, 50), 1), 'hi': round(_pct(eei_draw, 95), 1)}},
            'items': items}

# ------------------------------------------------------------------ 时间轴（按年重算，真实气候驱动）
def _clim_year(name, year):
    ys = (climate().get('stations', {}).get(name) or {}).get('years') or []
    for r in ys:
        if int(r[0]) == int(year):
            return float(r[1]), float(r[2])
    return None, None

def timeline(year):
    """把 2000–2024 逐年气候（NASA POWER 实测）代回同一套指标公式，得到"那一年的流域"。
    这不是趋势插值，也不是情景假设：T/P 是当年实测再分析值，其他输入（下垫面/地形）保持现状，
    所以读法是"若当年气候配上今天的下垫面，生态风险会是多少"，用于看气候驱动的那部分变化。"""
    sts = all_stations()
    items, ys = [], []
    for st in sts:
        T, P = _clim_year(st['name'], year)
        if T is None:
            continue
        m = _m(st, T_ov=T, P_ov=P)
        items.append({'name': st['name'], 'zone': st.get('zone', ''),
                      'T': round(T, 1), 'P': round(P),
                      'risk': round(m['risk'], 1), 'ei': round(m['ei'], 1),
                      'eei': round(m['eei'], 1), 'fvc': round(m['fvc'], 3),
                      'deg': round(m['deg'], 1), 'carbon': round(m['carbon'], 1),
                      'grade': _grade(m['eei'])})
        ys.append(m['risk'])
    if not items:
        return {'ok': False, 'error': '该年份没有气候序列'}
    n = len(items)
    basin = {'risk': round(sum(ys) / n, 1),
             'ei': round(sum(i['ei'] for i in items) / n, 1),
             'eei': round(sum(i['eei'] for i in items) / n, 1),
             'fvc': round(sum(i['fvc'] for i in items) / n, 3),
             'high': sum(1 for i in items if i['risk'] >= 58),
             'mid': sum(1 for i in items if 45 <= i['risk'] < 58),
             'low': sum(1 for i in items if i['risk'] < 45)}
    basin['grade'] = _grade(basin['eei'])
    return {'ok': True, 'year': int(year), 'n': n, 'basin': basin, 'items': items,
            'years': [int(r[0]) for r in (climate().get('basin') or [])]}

def timeline_series():
    """全站 × 全年的风险序列，用于画演变曲线与找拐点。"""
    sts = all_stations()
    years = [int(r[0]) for r in (climate().get('basin') or [])]
    out = {}
    for st in sts:
        arr = []
        for y in years:
            T, P = _clim_year(st['name'], y)
            if T is None:
                continue
            arr.append([y, round(_m(st, T_ov=T, P_ov=P)['risk'], 1)])
        if arr:
            out[st['name']] = arr
    basin = [[y, round(sum(v[1] for v in arr if v[0] == y) / max(1, sum(1 for v in arr if v[0] == y)), 1)]
             for y in years]
    return {'ok': True, 'years': years, 'stations': out, 'basin': basin}

# ------------------------------------------------------------------ 数据血缘与新鲜度
# 「数据是真的吗、多久没更新」这类问题必须能自证：接口给出每一层的来源、分辨率、
# 更新节律、文件时间与陈旧判定，前端原样展示，不做美化。
DATA_LAYERS = [
    {'key': 'dem', 'nm': '三维地形高程', 'file': 'dem.bin', 'kind': '实测/再分析',
     'src': 'Terrarium / SRTM（AWS Open Data）', 'res': '30 m → 742 m 重采样', 'cad': '静态',
     'stale': 3650, 'note': '静态底图，不随时间变化'},
    {'key': 'dem256', 'nm': '前端渲染高程', 'file': 'dem256.bin', 'kind': '派生',
     'src': '由 dem.bin 降采样', 'res': '256²', 'cad': '随 dem 重建', 'stale': 3650},
    {'key': 'stations', 'nm': '站点属性与评估', 'file': 'stations.json', 'kind': '实测/派生',
     'src': '水文站/梯级电站公开资料 + DEM 采样 + Sentinel-2 LULC', 'res': '20 站', 'cad': '人工维护',
     'stale': 180, 'note': '可在「区域治理」中人工修正，改动进台账'},
    {'key': 'climate', 'nm': '气候年值序列', 'file': 'climate.json', 'kind': '再分析',
     'src': 'NASA POWER（MERRA-2）逐年', 'res': '0.5°×0.625° → 站点高程订正', 'cad': '年度',
     'stale': 500, 'note': '每年 1 月补上一年'},
    {'key': 'streams', 'nm': '河网水系', 'file': 'streams.json', 'kind': '派生',
     'src': 'DEM 洼地填充 + D8 汇流累积提取', 'res': '365 条折线', 'cad': '静态', 'stale': 3650},
    {'key': 'detail', 'nm': '实景走廊补丁', 'file': 'detail.json', 'kind': '实测',
     'src': 'Copernicus DEM GLO-30 + Esri World Imagery z15', 'res': '30 m / ≈4 m/px', 'cad': '静态',
     'stale': 1825},
    {'key': 'gee', 'nm': 'GEE 遥感时序', 'file': 'gee/meta.json', 'kind': '卫星观测（云端提取）',
     'src': 'MODIS / GPM / ERA5-Land / GEDI（Earth Engine）', 'res': '站点 ±1 km 缓冲区',
     'cad': '月度增量', 'stale': 45, 'note': '需 tools/gee_sync.py 批处理'},
]

def data_provenance():
    items = []
    nowt = time.time()
    for L in DATA_LAYERS:
        fp = os.path.join(DATA, L['file'])
        it = dict(L)
        it.pop('stale', None)
        if os.path.isfile(fp):
            age = (nowt - os.path.getmtime(fp)) / 86400.0
            it.update({'exists': True, 'bytes': os.path.getsize(fp),
                       'updated': time.strftime('%Y-%m-%d %H:%M', time.localtime(os.path.getmtime(fp))),
                       'ageDays': round(age, 1),
                       'status': 'stale' if age > L['stale'] else 'ok'})
        else:
            it.update({'exists': False, 'bytes': 0, 'updated': None, 'ageDays': None,
                       'status': 'missing'})
        items.append(it)
    # GEE 额外补充覆盖度
    meta = rs_meta()
    if meta:
        for it in items:
            if it['key'] == 'gee':
                ser = rs_load('series.json') or {}
                it['rows'] = sum(len(v) for st in ser.values() for v in st.values())
                it['coverage'] = '%s ~ %s' % (
                    min((a[0][0] for st in ser.values() for a in st.values() if a), default='—'),
                    max((a[-1][0] for st in ser.values() for a in st.values() if a), default='—'))
                it['version'] = meta.get('version')
    ok = sum(1 for i in items if i['status'] == 'ok')
    return {'ok': True, 'generated': now(), 'items': items,
            'summary': {'total': len(items), 'ok': ok,
                        'stale': sum(1 for i in items if i['status'] == 'stale'),
                        'missing': sum(1 for i in items if i['status'] == 'missing')}}

def data_version():
    """轻量指纹：前端轮询它，只有变化时才重新拉数据，避免每 30 秒整页重绘。
    人工修正（govSeq）、站点表、气候序列、遥感批次任一变化都会改变指纹。"""
    parts = [str(gov()['seq'])]
    for f in ('stations.json', 'climate.json', 'gee/meta.json', 'dem.bin'):
        fp = os.path.join(DATA, f)
        parts.append('%.0f:%d' % (os.path.getmtime(fp), os.path.getsize(fp)) if os.path.isfile(fp) else '-')
    return {'ok': True, 'token': hashlib.md5('|'.join(parts).encode()).hexdigest()[:12],
            'govSeq': gov()['seq'], 'time': now()}

# ------------------------------------------------------------------ 会话
SESS = {}
FAILS = {}

def new_session(user, ttl):
    tok = secrets.token_urlsafe(32)
    sweep_sessions()
    SESS[tok] = {'u': user['u'], 'name': user['name'], 'role': user['role'], 'exp': time.time() + ttl}
    return tok

def sweep_sessions():
    """清掉过期会话。原来只在访问时顺带清理，长期不用的 token 会一直占内存。"""
    t = time.time()
    for k in [k for k, v in SESS.items() if v['exp'] <= t]:
        SESS.pop(k, None)

def session_of(handler):
    ck = handler.headers.get('Cookie', '')
    for part in ck.split(';'):
        if part.strip().startswith('sid='):
            tok = part.strip()[4:]
            s = SESS.get(tok)
            if s and s['exp'] > time.time(): return tok, s
            SESS.pop(tok, None)
    return None, None

# 一次性免密登录令牌：token -> user。仅供打包 exe 启动时用，用完即焚。
_AUTO = {}

def auto_login_token():
    """桌面版（打包 exe）：为第一个账号生成一次性免密登录令牌。
    浏览器访问 /auto?t=<token> 会自动登录并跳转三维主界面（用完即失效）。"""
    db = load_json(USERS, {"users": []})
    users = db.get('users', [])
    if not users:
        return None
    tok = secrets.token_urlsafe(32)
    _AUTO[tok] = users[0]
    return tok

def client_ip(h):
    xf = h.headers.get('X-Forwarded-For')
    return (xf.split(',')[0].strip() if xf else h.client_address[0])

# ------------------------------------------------------------------ HTTP
GZ_CACHE = {}
MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
        '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
        '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.bin': 'application/octet-stream'}

class H(BaseHTTPRequestHandler):
    server_version = 'JinshaEco/2.0'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        pass

    # ---------- 响应
    def send(self, code, body=b'', ctype='text/plain; charset=utf-8', headers=None):
        if isinstance(body, str): body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Content-Security-Policy', CSP_CESIUM if self.path.startswith('/cesium') else CSP)
        self.send_header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
        if self.headers.get('X-Forwarded-Proto') == 'https' or self.headers.get('CF-Visitor'):
            self.send_header('Strict-Transport-Security', 'max-age=31536000')
        for k, v in (headers or {}).items(): self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(body)

    def j(self, obj, code=200):
        self.send(code, json.dumps(obj, ensure_ascii=False), 'application/json; charset=utf-8',
                  {'Cache-Control': 'no-store'})

    def file(self, path, cache='no-cache'):
        if not os.path.isfile(path): return self.send(404, 'Not Found')
        ext = os.path.splitext(path)[1].lower()
        ctype = MIME.get(ext, 'application/octet-stream')
        gz = 'gzip' in self.headers.get('Accept-Encoding', '') and ext in ('.html', '.css', '.js', '.json', '.svg', '.bin')
        key = (path, os.path.getmtime(path), gz)
        data = GZ_CACHE.get(key)
        if data is None:
            with open(path, 'rb') as f: raw = f.read()
            data = gzip.compress(raw, 6) if gz else raw
            if len(GZ_CACHE) > 24: GZ_CACHE.clear()
            GZ_CACHE[key] = data
        hdr = {'Cache-Control': cache}
        if gz: hdr['Content-Encoding'] = 'gzip'; hdr['Vary'] = 'Accept-Encoding'
        self.send(200, data, ctype, hdr)

    # ---------- 路由
    def do_HEAD(self): self.do_GET()
    def do_GET(self):
        p = urllib.parse.urlparse(self.path).path
        if p in ('/', '/app', '/app.html', '/index.html'):
            tok, s = session_of(self)
            if not s: return self.send(302, b'', headers={'Location': '/login'})
            return self.file(os.path.join(WEB, 'app.html'))
        if p in ('/studio', '/studio.html'):
            tok, s = session_of(self)
            if not s: return self.send(302, b'', headers={'Location': '/login'})
            return self.file(os.path.join(WEB, 'index.html'))
        if p in ('/cesium2', '/cesium2.html'):
            tok, s2 = session_of(self)
            if not s2: return self.send(302, b'', headers={'Location': '/login'})
            return self.file(os.path.join(WEB, 'cesium2.html'))
        if p == '/auto':
            # 桌面版免密自动登录：/auto?t=<token> → 建立会话并跳转三维主界面
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            t = (q.get('t') or [''])[0]
            user = _AUTO.pop(t, None)
            if user:
                tok = new_session(user, SESSION_TTL)
                cookie = 'sid=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d' % (tok, SESSION_TTL)
                return self.send(302, b'', headers={'Location': '/', 'Set-Cookie': cookie})
            return self.send(302, b'', headers={'Location': '/login'})
        if p in ('/login', '/login.html'):
            return self.file(os.path.join(WEB, 'login.html'))
        if p in ('/dashboard', '/dashboard.html'):
            return self.file(os.path.join(WEB, 'dashboard.html'))
        if p == '/echarts.min.js':
            return self.file(os.path.join(WEB, 'echarts.min.js'), 'public, max-age=86400')
        if p.startswith('/assets/'):
            safe = os.path.normpath(p).replace('\\', '/')
            if '..' in safe: return self.send(403, 'Forbidden')
            return self.file(os.path.join(WEB, safe.lstrip('/')), 'public, max-age=86400')
        if p == '/api/session':
            tok, s = session_of(self)
            return self.j({'ok': bool(s), 'user': ({'u': s['u'], 'name': s['name'], 'role': s['role']} if s else None)})
        if p == '/api/health':
            meta = load_json(os.path.join(DATA, 'meta.json'), {})
            return self.j({'ok': True, 'version': meta.get('version'), 'built': meta.get('built'),
                           'stations': len(load_json(STATIONS, {}).get('stations', [])),
                           'govSeq': gov()['seq'], 'overrides': len(gov()['overrides']),
                           'dataToken': data_version()['token'],
                           'time': now()})
        if p == '/api/sync':
            threading.Thread(target=_climate_refresh, daemon=True).start()
            return self.j({'ok': True, 'msg': '已开始后台同步（气候年值序列）'})

        if p == '/api/data/version':
            return self.j(data_version())
        # 数据接口：/api/data/<name> 读 data/ 下 json
        # 前 5 类：RSEI/土地利用/灯光/人口/空间自相关（GEE 生产）
        # 后 10 类：云库快照离线还原的气候/水文/生态分析表（tools/snapshot_to_json.py）
        if p.startswith('/api/data/'):
            name = p[len('/api/data/'):]
            table = {
                'rsei': os.path.join(DATA, 'rsei', 'rsei_all.json'),
                'lulc': os.path.join(DATA, 'lulc', 'lulc.json'),
                'nightlight': os.path.join(DATA, 'nightlight', 'nightlight.json'),
                'population': os.path.join(DATA, 'population', 'population.json'),
                'moran': os.path.join(DATA, 'rsei', 'moran_lisa.json'),
                'climate_monthly': os.path.join(DATA, 'climate_monthly.json'),
                'climate_annual': os.path.join(DATA, 'climate_annual.json'),
                'climate_trend': os.path.join(DATA, 'climate_trend.json'),
                'basin_monthly': os.path.join(DATA, 'basin_monthly.json'),
                'basin_annual': os.path.join(DATA, 'basin_annual.json'),
                'climate_crosscheck': os.path.join(DATA, 'climate_crosscheck.json'),
                'hydro_monthly': os.path.join(DATA, 'hydro_monthly.json'),
                'hydro_annual': os.path.join(DATA, 'hydro_annual.json'),
                'eco_services': os.path.join(DATA, 'eco_services.json'),
                'station_climate': os.path.join(DATA, 'station_climate.json'),
            }
            if name in table:
                return self.j(load_json(table[name], []))
            return self.j({'error': 'unknown dataset'}, 404)
        if p == '/api/scope':
            return self.j(load_json(os.path.join(DATA, 'scope.json'), {}))
        if p == '/api/tennant':
            rows = load_json(os.path.join(DATA, 'hydro_monthly.json'), [])
            return self.j({'ok': True, 'method': '季节化生态流量基准：各站逐月径流中位数 Q50（GloFAS 模型派生，非实测保证率）',
                           'source': 'GloFAS v4（Open-Meteo Flood API）',
                           'stations': tennant_baseline(rows)})
        if p == '/api/trend/hydro':
            rows = load_json(os.path.join(DATA, 'hydro_monthly.json'), [])
            by_st = {}
            for r in rows:
                nm = r.get('station'); m = r.get('month'); q = r.get('discharge_m3s')
                if nm is None or m is None or q in (None, ''):
                    continue
                by_st.setdefault(nm, {}).setdefault(int(m), []).append(float(q))
            items = []
            for nm, months in by_st.items():
                res = seasonal_mk(months)
                if res:
                    res['station'] = nm
                    items.append(res)
            items.sort(key=lambda x: x['tau'])
            return self.j({'ok': True, 'metric': 'discharge', 'method': '季节化 Mann-Kendall（Hirsch–Slack）',
                           'unit': 'm³/s/月', 'items': items})
        if p == '/api/river/compare':
            return self.j({'ok': True, **river_compare()})
        # 以下需登录
        tok, s = session_of(self)
        if not s: return self.j({'ok': False, 'error': '未登录或会话已过期'}, 401)
        if p == '/api/provenance':
            return self.j(data_provenance())
        if p == '/api/timeline':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try: yr = int((qs.get('year') or ['2024'])[0])
            except Exception: yr = 2024
            return self.j(timeline(yr))
        if p == '/api/timeline/series':
            return self.j(timeline_series())
        if p == '/api/repro':
            return self.j(repro_pack())
        if p == '/api/diagnose':
            return self.j(diagnose())
        if p == '/api/evidence':
            return self.j(evidence_summary())
        if p == '/api/conclusion':
            return self.j(conclusion())
        if p == '/api/patrol/plan':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try: n = min(20, max(1, int((qs.get('top') or ['6'])[0])))
            except Exception: n = 6
            return self.j(patrol_plan(n))
        if p == '/api/uncertainty':
            return self.j(uncertainty())
        if p == '/api/validate':
            return self.j({'ok': True, 'data': load_json(os.path.join(DATA, 'validate.json'), {})})
        if p == '/api/db/status':
            st = load_json(os.path.join(DATA, 'pg_status.json'), None)
            if not st:
                return self.j({'ok': False, 'error': '尚未入库，先执行 python tools/pg_sync.py'})
            return self.j(st)
        # ---------- 遥感（GEE）时序
        if p == '/api/rs/status':
            meta = rs_meta()
            series = rs_load('series.json') or {}
            annual = rs_load('annual.json') or {}
            out = []
            for k, v in (meta.get('metrics') or {}).items():
                sts = series.get(k) or {}
                n = sum(len(a) for a in sts.values())
                first = min((a[0][0] for a in sts.values() if a), default=None)
                last = max((a[-1][0] for a in sts.values() if a), default=None)
                out.append({'code': k, 'name': v.get('name'), 'unit': v.get('unit'),
                            'collection': v.get('collection'), 'freq': v.get('freq'),
                            'rows': n, 'stations': len(sts), 'from': first, 'to': last,
                            'annual': len(next(iter((annual.get(k) or {}).values()), []) or [])})
            return self.j({'ok': True, 'available': bool(meta), 'meta': meta,
                           'metrics': out, 'stations': len(load_json(STATIONS, {}).get('stations', []))})
        if p == '/api/rs/series':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            k = (qs.get('metric') or ['ndvi'])[0]
            nm = (qs.get('station') or [''])[0]
            series = rs_load('series.json') or {}
            if k not in series: return self.j({'ok': False, 'error': '尚无该指标的遥感序列：%s' % k}, 404)
            if nm:
                pts = (series[k] or {}).get(nm)
                if pts is None: return self.j({'ok': False, 'error': '该站点无数据'}, 404)
                return self.j({'ok': True, 'metric': k, 'station': nm, 'points': pts})
            return self.j({'ok': True, 'metric': k, 'stations': list((series[k] or {}).keys())})
        if p == '/api/rs/trend':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            k = (qs.get('metric') or ['ndvi'])[0]
            annual = (rs_load('annual.json') or {}).get(k) or {}
            if not annual: return self.j({'ok': False, 'error': '尚无该指标的年值序列：%s' % k}, 404)
            items = []
            for nm, arr in annual.items():
                r = _sen_mk([v for _, v in arr])
                if not r: continue
                r['station'] = nm
                r['latest'] = arr[-1][1] if arr else None
                r['latestYear'] = arr[-1][0] if arr else None
                items.append(r)
            items.sort(key=lambda x: x['sen'])
            return self.j({'ok': True, 'metric': k, 'items': items,
                           'unit': (rs_meta().get('metrics', {}).get(k) or {}).get('unit')})
        if p == '/api/rs/basin':
            # 流域平均年值序列（各站等权），用于前端折线/趋势卡
            annual = rs_load('annual.json') or {}
            out = {}
            for k, sts in annual.items():
                years = {}
                for arr in sts.values():
                    for y, v in arr:
                        years.setdefault(y, []).append(v)
                out[k] = [[y, round(sum(v) / len(v), 4)] for y, v in sorted(years.items()) if v]
            return self.j({'ok': True, 'metrics': out})

        # ---------- 数据治理（区域口径）
        if p == '/api/regions':
            out = []
            for d in region_defs():
                sts, _ = region_stations(d['id'])
                if not sts: continue
                row = {k: v for k, v in d.items() if not k.startswith('_')}
                row['count'] = len(sts)
                row['edited'] = sum(1 for x in sts if ov_of(x['name']))
                row['names'] = [x['name'] for x in sts]
                row['mean'] = region_means(sts)
                out.append(row)
            return self.j({'ok': True, 'regions': out, 'fields': FIELD_LIST,
                           'reserved': RESERVED_FIELDS, 'govSeq': gov()['seq'],
                           'overrides': len(gov()['overrides'])})
        if p == '/api/region':
            rid = (urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('id') or ['basin'])[0]
            pl, err = region_payload(rid)
            if err: return self.j({'ok': False, 'error': err}, 404)
            return self.j(pl)
        if p == '/api/anomalies':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fid = (qs.get('field') or [''])[0] or None
            lst = anomaly_scan(fid)
            return self.j({'ok': True, 'count': len(lst), 'items': lst,
                           'dismissed': len(gov().get('dismissals', [])),
                           'method': '稳健 Z 分数（中位数 + 1.4826·MAD）+ 空间邻域一致性双判据；'
                                     '气温按 6.5 ℃/km 订正到站点高程后比较'})
        if p == '/api/changes':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try: lim = min(100, max(1, int((qs.get('limit') or ['20'])[0])))
            except Exception: lim = 20
            chs = gov()['changes'][-lim:][::-1]
            return self.j({'ok': True, 'seq': gov()['seq'], 'count': len(chs), 'changes': chs})
        if p == '/api/observations':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            nm = (qs.get('station') or [''])[0]
            obs = gov()['observations']
            if nm: obs = [o for o in obs if o.get('station') == nm]
            return self.j({'ok': True, 'count': len(obs), 'observations': obs[-40:][::-1]})
        if p == '/api/gov/export':
            return self.send(200, gov_csv(), 'text/csv; charset=utf-8',
                             {'Content-Disposition': 'attachment; filename="jinsha_governance.csv"'})
        if p == '/api/stations':
            return self.j(load_json(STATIONS, {'stations': []}))
        if p == '/api/legacy/stations':
            return self.j([legacy_station(x) for x in load_json(STATIONS, {'stations': []})['stations']])
        if p == '/api/eco-services':
            items = [eco_item(x) for x in load_json(STATIONS, {'stations': []})['stations']]
            return self.j({'ok': True, 'items': items})
        if p == '/api/eco-assess':
            items = [eco_item(x) for x in load_json(STATIONS, {'stations': []})['stations']]
            return self.j(eco_assess(items))
        if p == '/api/trend':
            cl = climate()
            return self.j([{'year': r[0], 't': r[1], 'p': r[2], 'et': r[3]} for r in cl.get('basin', [])])
        if p == '/api/climate':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            name = (qs.get('name') or [''])[0]
            cl = climate()
            if name:
                st = cl.get('stations', {}).get(name)
                if not st: return self.j({'ok': False, 'error': '无该站气候序列'}, 404)
                return self.j({'ok': True, 'name': name, 'source': cl.get('source'),
                               'gridElev': st.get('gridElev'), 'lapseCorr': st.get('lapseCorr'),
                               'years': st.get('years', [])})
            return self.j({'ok': True, 'source': cl.get('source'), 'period': cl.get('period'),
                           'note': cl.get('note'), 'basin': cl.get('basin', []),
                           'stations': list(cl.get('stations', {}).keys())})
        if p == '/api/db/tables':
            return self.j({'ok': True, 'db': 'jinsha', 'tables': db_schema()})
        if p == '/api/fs/tree':
            return self.j({'ok': True, 'tree': fs_tree()})
        if p == '/api/fs/read':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            out, err = fs_read((qs.get('path') or [''])[0])
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)
        if p == '/api/llm/plan':
            return self.j({'ok': False, 'error': '未配置大模型，已回退规则引擎'})
        if p == '/api/ml/results':
            return self.j(FT.ml_results())
        if p.startswith('/api/tasks/'):
            t = FT.get_task(p.split('/')[-1])
            return self.j(t or {'ok': False, 'error': '任务不存在'}, 200 if t else 404)
        if p == '/api/tasks':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            try: lim = int((qs.get('limit') or [20])[0])
            except Exception: lim = 20
            return self.j(FT.list_tasks(lim))
        if p == '/api/scenarios':
            return self.j(FT.list_scenarios())
        if p == '/api/export/dataset':
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            fmt = (qs.get('fmt') or ['csv'])[0]
            sts = all_stations()
            # 用系统官方的中文扁平数据源（与 /api/export.csv 同源），字段最全、无空值
            met = {x['name']: legacy_station(x) for x in sts}
            out = FT.export_dataset(sts, met, fmt)
            if fmt == 'json':
                return self.j(out)
            return self.send(200, out['csv'], 'text/csv; charset=utf-8',
                             {'Content-Disposition': 'attachment; filename=jinsha_dataset.csv'})
        if p == '/api/summary':
            st = load_json(STATIONS, {'stations': []})['stations']
            items = [eco_item(x) for x in st]
            return self.j({'ok': True, 'stations': len(st),
                           'eei': round(sum(i['eei'] for i in items) / max(1, len(items)), 1),
                           'version': load_json(os.path.join(DATA, 'meta.json'), {}).get('version')})
        if p == '/api/audit':
            rows = []
            if os.path.exists(AUDIT):
                with open(AUDIT, encoding='utf-8') as f: rows = [json.loads(l) for l in f if l.strip()][-40:][::-1]
            return self.j({'ok': True, 'rows': rows})
        if p in ('/cesium', '/cesium.html'):
            tok, s = session_of(self)
            if not s: return self.send(302, b'', headers={'Location': '/login'})
            return self.file(os.path.join(WEB, 'cesium.html'))
        if p == '/report':
            tok, s = session_of(self)
            if not s: return self.send(302, b'', headers={'Location': '/login'})
            return self.send(200, report_html(), 'text/html; charset=utf-8')
        if p.startswith('/data/detail/'):
            # 文件名是中文站名，URL 里是百分号编码，取 basename 前必须先解码
            base = os.path.basename(urllib.parse.unquote(p))
            if base.startswith('.') or not base.endswith(('.jpg', '.bin')):
                return self.send(403, 'Forbidden')
            # 实景补丁是一次生成、长期不变的静态资源，允许浏览器缓存一天
            return self.file(os.path.join(DATA, 'detail', base), 'public, max-age=86400')
        if p.startswith('/data/tiles/'):
            # 离线影像瓦片：/data/tiles/{z}/{x}/{y}.jpg
            safe = os.path.normpath(p).replace('\\', '/')
            if '..' in safe or not safe.endswith(('.jpg', '.jpeg', '.png')):
                return self.send(403, 'Forbidden')
            return self.file(os.path.join(DATA, safe[len('/data/'):]), 'public, max-age=604800')
        if p.startswith('/data/'):
            safe = os.path.normpath(p).replace('\\', '/')
            base = os.path.basename(safe)
            # 隐藏文件（.power_cache.json / .secret 等）一律不外发
            if '..' in safe or base.startswith('.') or not base.endswith(('.json', '.bin')):
                return self.send(403, 'Forbidden')
            return self.file(os.path.join(DATA, base), 'no-cache')
        if p == '/api/export.csv':
            st = load_json(STATIONS, {'stations': []})['stations']
            buf = io.StringIO(); w = csv.writer(buf)
            w.writerow(['站点', '英文', '经度', '纬度', '海拔m', '坡度°', '林地', '草地灌丛', '农田', '建成区',
                        '裸地', '水体', '年均温℃', '年降水mm', '影像绿度', '已修正字段'])
            for x in st:
                ed = sorted(ov_of(x['name']).keys())
                w.writerow([x['name'], x['en'], x['lon'], x['lat'], round(eff_val(x, 'elev')), eff_val(x, 'slope'),
                            round(eff_val(x, 'lc.林地'), 4), round(eff_val(x, 'lc.草地灌丛'), 4),
                            round(eff_val(x, 'lc.农田'), 4), round(eff_val(x, 'lc.建成区'), 4),
                            round(eff_val(x, 'lc.裸地'), 4), round(eff_val(x, 'lc.水体'), 4),
                            round(eff_val(x, 'temp'), 1), round(eff_val(x, 'precip')),
                            x.get('vgi'), '|'.join(ed)])
            data = ('\ufeff' + buf.getvalue()).encode('utf-8')
            return self.send(200, data, 'text/csv; charset=utf-8',
                             {'Content-Disposition': 'attachment; filename="jinsha_stations.csv"'})
        return self.send(404, 'Not Found')

    def do_POST(self):
        p = urllib.parse.urlparse(self.path).path
        try: n = int(self.headers.get('Content-Length') or 0)
        except ValueError: n = 0
        if n > MAX_BODY:
            # 不读请求体，直接断开，避免被超大 Content-Length 拖住内存/连接
            self.close_connection = True
            return self.j({'ok': False, 'error': '请求体过大（上限 8 MB）'}, 413)
        raw = self.rfile.read(n) if n else b'{}'
        try: body = json.loads(raw.decode('utf-8') or '{}')
        except Exception: body = {}

        if p == '/api/login':
            ip = client_ip(self)
            f = FAILS.setdefault(ip, [])
            FAILS[ip] = [t for t in f if time.time() - t < FAIL_WINDOW]
            if len(FAILS[ip]) >= MAX_FAIL:
                return self.j({'ok': False, 'error': '尝试次数过多，请 10 分钟后再试'}, 429)
            u = (body.get('username') or '').strip(); pw = body.get('password') or ''
            ok, user = check_user(u, pw)
            if not ok:
                FAILS[ip].append(time.time()); time.sleep(0.4)
                return self.j({'ok': False, 'error': '用户名或密码不正确'}, 401)
            FAILS.pop(ip, None)
            ttl = SESSION_TTL * (7 if body.get('remember') else 1)
            tok = new_session(user, ttl)
            cookie = 'sid=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d' % (tok, ttl)
            self.send(200, json.dumps({'ok': True, 'user': {'u': user['u'], 'name': user['name']}}, ensure_ascii=False),
                      'application/json; charset=utf-8', {'Set-Cookie': cookie, 'Cache-Control': 'no-store'})
            try:
                audit({'t': now(), 'user': u, 'ip': ip, 'act': '登录'})
            except Exception:
                pass
            return

        tok, s = session_of(self)
        if not s: return self.j({'ok': False, 'error': '未登录或会话已过期'}, 401)

        if p == '/api/logout':
            if tok: SESS.pop(tok, None)
            return self.send(200, json.dumps({'ok': True}), 'application/json; charset=utf-8',
                             {'Set-Cookie': 'sid=; Path=/; Max-Age=0'})

        if p == '/api/stations':
            name = (body.get('name') or '').strip()
            try: lon, lat = float(body.get('lon')), float(body.get('lat'))
            except Exception: return self.j({'ok': False, 'error': '经纬度格式不正确'}, 400)
            if not name or not (97 < lon < 106) or not (25 < lat < 33):
                return self.j({'ok': False, 'error': '名称必填，且坐标需在研究区内'}, 400)
            db = load_json(STATIONS, {'stations': []})
            if any(x['name'] == name for x in db['stations']):
                return self.j({'ok': False, 'error': '同名站点已存在'}, 409)
            el = dem_at(lon, lat); ex = enrich(lon, lat)
            rec = {"id": 'u%d' % int(time.time()), "name": name, "en": body.get('en') or '',
                   "lon": lon, "lat": lat, "type": body.get('type') or '生态监测站',
                   "zone": body.get('zone') or '人工新增', "elev": round(el),
                   "slope": slope_at(lon, lat), "aspect": 0, "relief": 0,
                   "temp": body.get('temp'), "precip": body.get('precip'),
                   "lc": ex['lc'], "vgi": None, "greenFrac": None,
                   "coordSrc": '用户录入', "elevSrc": 'DEM 双线性采样',
                   "lcSrc": ex['lcSrc'], "climSrc": '用户录入/待补',
                   "manual": True, "addedBy": s['u'], "addedAt": now()}
            db['stations'].append(rec)
            db['version'] = time.strftime('%Y.%m.%d')
            save_json(STATIONS, db)
            audit({'t': now(), 'user': s['u'], 'ip': client_ip(self), 'act': '新增站点', 'name': name})
            return self.j({'ok': True, 'station': rec})

        if p == '/api/db/query':
            out, err = db_query(body.get('sql') or '')
            if err: return self.j({'ok': False, 'error': err}, 400)
            try:
                audit({'t': now(), 'user': s['u'], 'ip': client_ip(self),
                       'act': '数据库查询', 'sql': (body.get('sql') or '')[:120]})
            except Exception:
                pass
            return self.j(out)

        if p == '/api/llm/plan':
            out, err = llm_forward(body)
            if err:
                return self.j({'ok': False, 'error': err}, 502)
            try:
                audit({'t': now(), 'user': s['u'], 'ip': client_ip(self),
                       'act': '模型规划', 'model': body.get('model')})
            except Exception:
                pass
            return self.j(out)

        if p == '/api/tasks':
            tid = 'T%d' % int(time.time())
            rec = FT.create_task(tid, body.get('model'), body.get('name'), s['u'])
            # 真实执行：用当前站点数据完成模型计算（本系统中模型为轻量指标计算，秒级完成）
            FT.run_task(tid)
            audit({'t': now(), 'user': s['u'], 'ip': client_ip(self), 'act': '派发任务', 'id': tid, 'model': body.get('model')})
            return self.j({'ok': True, 'id': tid, 'status': 'done', 'progress': 100})

        if p == '/api/ml/train':
            # 真实训练：5 种算法 × 留一法交叉验证，基于 20 站真实数据
            sts = all_stations()
            met = {x['name']: eco_item(x) for x in sts}
            # 标签需要的综合风险来自同一引擎的 legacy_station（eco_item 不含该字段）
            for x in sts:
                mm = _m(x)
                met[x['name']]['risk'] = legacy_station(x)['综合风险']
                met[x['name']]['fvc'] = mm['fvc']
            result = FT.train_models(sts, met)
            audit({'t': now(), 'user': s['u'], 'ip': client_ip(self), 'act': 'ML训练',
                   'n': result.get('n'), 'best': result.get('best')})
            return self.j(result)

        if p == '/api/scenario':
            out = FT.save_scenario(body.get('name'), body.get('data'), s['u'])
            audit({'t': now(), 'user': s['u'], 'ip': client_ip(self), 'act': '保存情景', 'id': out['id']})
            return self.j(out)

        if p == '/api/password':
            old = body.get('old') or ''
            new = body.get('new') or ''
            ok, user = check_user(s['u'], old)
            if not ok: return self.j({'ok': False, 'error': '原密码不正确'}, 400)
            if len(new) < 8: return self.j({'ok': False, 'error': '新密码至少 8 位'}, 400)
            if new == old: return self.j({'ok': False, 'error': '新密码不能与原密码相同'}, 400)
            set_password(s['u'], new)
            audit({'t': now(), 'user': s['u'], 'ip': client_ip(self), 'act': '修改密码'})
            return self.j({'ok': True})

        if p == '/api/import':
            text = body.get('csv') or ''
            if not text.strip(): return self.j({'ok': False, 'error': 'CSV 为空'}, 400)
            db = load_json(STATIONS, {'stations': []})
            idx = {x['name']: x for x in db['stations']}
            added = updated = skipped = 0
            reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
            for row in reader:
                name = (row.get('站点') or row.get('name') or '').strip()
                try: lon = float(row.get('经度') or row.get('lon')); lat = float(row.get('纬度') or row.get('lat'))
                except Exception:
                    skipped += 1; continue
                if not name or not (97 < lon < 106) or not (25 < lat < 33):
                    skipped += 1; continue
                if name in idx:
                    x = idx[name]; x['lon'], x['lat'] = lon, lat
                    x['elev'] = round(dem_at(lon, lat)); x['slope'] = slope_at(lon, lat)
                    for k, kk in (('年均温℃', 'temp'), ('年降水mm', 'precip')):
                        if row.get(k): x[kk] = float(row[k])
                    updated += 1
                else:
                    rec = {"id": 'i%d' % int(time.time() * 1000 + added), "name": name, "en": '', "lon": lon, "lat": lat,
                           "type": row.get('类型') or '生态监测站', "zone": '批量导入', "elev": round(dem_at(lon, lat)),
                           "slope": slope_at(lon, lat), "aspect": 0, "relief": 0,
                           "temp": float(row['年均温℃']) if row.get('年均温℃') else None,
                           "precip": float(row['年降水mm']) if row.get('年降水mm') else None,
                           "lc": {}, "vgi": None, "greenFrac": None, "coordSrc": '用户导入',
                           "elevSrc": 'DEM 双线性采样', "lcSrc": '待补', "climSrc": '用户导入',
                           "manual": True, "addedBy": s['u'], "addedAt": now()}
                    db['stations'].append(rec); idx[name] = rec; added += 1
            db['version'] = time.strftime('%Y.%m.%d')
            save_json(STATIONS, db)
            audit({'t': now(), 'user': s['u'], 'ip': client_ip(self), 'act': '导入CSV',
                   'added': added, 'updated': updated})
            return self.j({'ok': True, 'added': added, 'updated': updated, 'skipped': skipped,
                           'total': len(db['stations'])})

        # ---------- 数据治理（人工修正 / 追加观测 / 撤销）
        if p == '/api/region/adjust':
            out, err = apply_adjust((body.get('region') or '').strip(), (body.get('field') or '').strip(),
                                    (body.get('op') or 'set').strip(), body.get('value'),
                                    body.get('reason'), body.get('source'), s['u'])
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)

        if p == '/api/station/correct':
            out, err = apply_correct((body.get('name') or '').strip(), (body.get('field') or '').strip(),
                                     body.get('value'), body.get('reason'), body.get('source'), s['u'])
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)

        if p == '/api/region/reset':
            out, err = apply_reset((body.get('region') or '').strip(),
                                   (body.get('field') or '').strip() or None, s['u'],
                                   body.get('reason') or '批量回退为原始观测')
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)

        if p == '/api/changes/undo':
            out, err = undo_change((body.get('id') or '').strip(), s['u'])
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)

        if p == '/api/observations':
            out, err = add_observation((body.get('station') or '').strip(), (body.get('field') or '').strip(),
                                       body.get('value'), body.get('t'), body.get('source'),
                                       body.get('note'), s['u'], body.get('apply', True) is not False)
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)

        if p == '/api/anomalies/dismiss':
            out, err = dismiss_anomaly((body.get('station') or '').strip(), (body.get('field') or '').strip(),
                                       body.get('reason'), s['u'])
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)

        if p == '/api/regions':
            out, err = add_region(body.get('name'), body.get('bbox') or [], body.get('note'), s['u'])
            if err: return self.j({'ok': False, 'error': err}, 400)
            return self.j(out)

        if p == '/api/regions/delete':
            rid = (body.get('id') or '').strip()
            g = gov()
            n0 = len(g['regions'])
            g['regions'] = [r for r in g['regions'] if r['id'] != rid]
            if len(g['regions']) == n0: return self.j({'ok': False, 'error': '未找到该自定义区域'}, 404)
            gov_save()
            audit({'t': now(), 'user': s['u'], 'ip': client_ip(self), 'act': '删除区域', 'id': rid})
            return self.j({'ok': True, 'deleted': rid})

        return self.send(404, 'Not Found')




# ------------------------------------------------------------------ 指标（与前端同一口径）
def _f(st, k):
    """下垫面占比的有效值（人工修正 > 原始土地覆盖统计）"""
    return float(eff_val(st, 'lc.' + k))

def _m(st, T_ov=None, P_ov=None):
    f, g, c = _f(st, '林地'), _f(st, '草地灌丛'), _f(st, '农田')
    b, ba, w, we = _f(st, '建成区'), _f(st, '裸地'), _f(st, '水体'), _f(st, '湿地')
    # 气候优先用 NASA POWER 2000–2024 实测序列均值；有人工修正时以修正值为准（台账留痕）。
    # T_ov / P_ov 用于「时间轴」：传入某一年的实测气候，其余输入保持不变，得到该年的指标。
    P = float(P_ov) if P_ov is not None else eff_val(st, 'precip')
    T = float(T_ov) if T_ov is not None else eff_val(st, 'temp')
    slope = float(st.get('slope') or 0)
    relief = float(st.get('relief') or 0)
    fvc = min(1, f * .92 + g * .62 + c * .55 + we * .75 + ba * .05 + b * .08)
    carbon = (f * 52 + g * 7.5 + c * 5.2 + we * 18 + ba * .4 + b * 1.2) * (.72 + .28 * min(1.35, max(.45, P / 1200)))
    slide = 100 * (.42 * min(1, max(0, (slope - 4) / 28)) + .18 * min(1, relief / 800) +
                   .22 * min(1, P / 1600) + .18 * (1 - min(1, f * .8 + g * .35)))
    dry = min(1, max(0, (T - 6) / 18)) * min(1, max(.15, 1 - P / 1800))
    deg = 100 * (.4 * (1 - fvc) + .3 * dry + .18 * min(1, b / .10) + .12 * (1 - f))
    lsi = 100 * (.45 * min(1, max(0, (slope - 5) / 30)) + .30 * min(1, relief / 900) +
                 .15 * min(1, b / .12) + .10 * min(1, ba / .15))
    abi = 100 * (.35 * f + .21 * g + .28 * (w + we) + .11 * c + .04 * b + .01 * ba)
    wri = 100 * (.70 * min(1, P / 1600) + .30 * min(1, (w + we) / .05))
    ei = (.35 * abi + .25 * fvc * 100 + .15 * wri + .15 * (100 - lsi)) / .90
    risk = .42 * slide + .33 * deg + .25 * lsi
    habitat = min(1, f * .95 + g * .72 + we * .90 + w * .78 + c * .42 + b * .08 + ba * .20)
    biodiversity = min(1, habitat * (.78 + .22 * f))
    water = P * (.50 + .42 * f)
    soil = max(0, min(40, 10 + 40 * f - slope * .20 + g * 5))
    climate = min(1, .35 + .50 * f + .20 * g)
    resilience = min(1, max(.08, .30 + .55 * f + .20 * g - .15 * b))
    esv = max(0, min(4, 1.0 + 3.0 * f + 1.3 * g + .9 * we + .5 * w - .3 * ba))
    disturbance = min(1, b * 2.8 + c * .45 + ba * .5)
    eei = (18 * habitat + 15 * biodiversity + 14 * (water / 1000) + 12 * (soil / 40) +
           12 * climate + 11 * resilience + 10 * (esv / 4) + 8 * (1 - disturbance))
    return dict(fvc=fvc, carbon=carbon, slide=slide, deg=deg, lsi=lsi, abi=abi, wri=wri,
                ei=ei, risk=risk, habitat=habitat, biodiversity=biodiversity, water=water,
                soil=soil, climate=climate, resilience=resilience, esv=esv,
                disturbance=disturbance, eei=eei)

def _grade(v):
    return 'A' if v >= 75 else 'B' if v >= 65 else 'C' if v >= 55 else 'D'

def legacy_station(st):
    m = _m(st)
    r = m['risk']
    cm = clim_mean(st.get('name'))
    return {
        '名称': st['name'], '英文': st.get('en', ''), '经度': st['lon'], '纬度': st['lat'],
        '海拔': round(eff_val(st, 'elev')), '类型': st.get('type', '生态监测站'),
        '风险评级': '高风险' if r >= 58 else '中风险' if r >= 45 else '低风险',
        '滑坡敏感性': round(m['slide'] / 100, 2), '碳密度': round(m['carbon'], 1),
        '植被覆盖': round(m['fvc'], 2), '分区名': st.get('zone', ''),
        '多年年均温': round(eff_val(st, 'temp'), 1),
        '多年年降水': round(eff_val(st, 'precip'), 1),
        '多年年蒸散': round(cm[2], 1) if cm else round((eff_val(st, 'precip') or 1000) * .78 + 120),
        '干燥指数': round(cm[2] / eff_val(st, 'precip'), 2) if (cm and eff_val(st, 'precip')) else round(
            ((eff_val(st, 'precip') or 1000) * .78 + 120) / (eff_val(st, 'precip') or 1000), 2),
        '退化风险': round(m['deg'] / 100, 2), '生态质量': round(m['ei'] / 100, 2),
        '树冠覆盖': round(rs_tcc_map().get(st['name'], _f(st, '林地') * 100) / 100, 3),
        '树冠来源': 'Hansen 30m treecover2000' if st['name'] in rs_tcc_map() else 'Sentinel-2 LULC 推算',
        '草地覆盖': round(_f(st, '草地灌丛'), 2),
        '农田覆盖': round(_f(st, '农田'), 3), '综合风险': round(r, 1),
        '土地胁迫': round(m['lsi'], 1), '综合指数EI': round(m['ei'], 2),
        'NDVI趋势': (round(rs_trend_map()[st['name']]['sen'], 5) if st['name'] in rs_trend_map() else None),
        'NDVI趋势显著性': (rs_trend_map()[st['name']]['trend'] if st['name'] in rs_trend_map() else None),
        '已修正字段': sorted(ov_of(st.get('name')).keys())
    }

def eco_item(st):
    m = _m(st)
    tr = rs_trend_map().get(st['name']) or {}
    return {
        'ndviSen': tr.get('sen'), 'ndviP': tr.get('p'), 'ndviTrend': tr.get('trend'),
        'name': st['name'], 'zone': st.get('zone', ''), 'elev': round(eff_val(st, 'elev')),
        'habitat': round(m['habitat'], 3), 'biodiversity': round(m['biodiversity'], 3),
        'water': round(m['water'], 1), 'soil': round(m['soil'], 1),
        'climate': round(m['climate'], 3), 'resilience': round(m['resilience'], 3),
        'esv': round(m['esv'], 2), 'disturbance': round(m['disturbance'], 3),
        'eei': round(m['eei'], 1), 'grade': _grade(m['eei'])
    }

def eco_assess(items):
    if not items:
        return {'ok': False, 'error': 'no data'}
    keys = ['habitat', 'biodiversity', 'water', 'soil', 'climate', 'resilience', 'esv', 'disturbance']
    means = {k: round(sum(i[k] for i in items) / len(items), 2) for k in keys}
    best = max(items, key=lambda x: x['eei'])
    worst = min(items, key=lambda x: x['eei'])
    grades = {}
    for i in items:
        grades[i['grade']] = grades.get(i['grade'], 0) + 1
    zones = {}
    for i in items:
        z = zones.setdefault(i['zone'] or '未分区', {'zone': i['zone'] or '未分区', 'n': 0, 's': 0})
        z['n'] += 1; z['s'] += i['eei']
    zl = [{'zone': z['zone'], 'n': z['n'], 'eei': round(z['s'] / z['n'], 1)} for z in zones.values()]
    names = {'habitat': '生境质量', 'biodiversity': '生物多样性', 'water': '水源涵养', 'soil': '土壤保持',
             'climate': '气候调节', 'resilience': '生态韧性', 'esv': '服务价值', 'disturbance': '人类干扰'}
    norm = {'habitat': 1, 'biodiversity': 1, 'water': 1000, 'soil': 40, 'climate': 1,
            'resilience': 1, 'esv': 4, 'disturbance': 1}
    weak = sorted(keys, key=lambda k: (means[k] / norm[k]) * (1 if k != 'disturbance' else -1))[:3]
    return {'ok': True, 'means': means,
            'best': {'name': best['name'], 'eei': best['eei'], 'grade': best['grade']},
            'worst': {'name': worst['name'], 'eei': worst['eei'], 'grade': worst['grade']},
            'grades': grades,
            'zones': sorted(zl, key=lambda z: -z['eei']),
            'weakest': [{'dim': names[k], 'mean': means[k]} for k in weak]}



# ------------------------------------------------------------------ 气候序列（NASA POWER / MERRA-2）
_CLIM = None
def climate():
    """加载 data/climate.json，并预先算好每站 25 年均值，供指标计算直接取用。"""
    global _CLIM
    if _CLIM is None:
        raw = load_json(os.path.join(DATA, 'climate.json'), {}) or {}
        means = {}
        for name, s in (raw.get('stations') or {}).items():
            ys = s.get('years') or []
            if ys:
                n = len(ys)
                means[name] = (sum(r[1] for r in ys) / n,
                               sum(r[2] for r in ys) / n,
                               sum(r[3] for r in ys) / n)
        raw['_means'] = means
        _CLIM = raw
    return _CLIM

def clim_mean(name):
    return climate().get('_means', {}).get(name)

def _slope(xs, ys):
    """最小二乘斜率（用于升温速率 / 降水变化率）。"""
    n = len(xs)
    if n < 3: return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    return 0.0 if not den else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den

# ------------------------------------------------------------------ 虚拟数据库（只读）
def _db_tables():
    """把 data/*.json 投影成 4 张只读表，供智能体的 db_tables / db_query 使用。
    同一份数据既做「表结构」也做「查询结果」，不会出现结构对不上数据的情况。"""
    st = load_json(STATIONS, {'stations': []})['stations']
    def lc(x, k): return round(eff_val(x, 'lc.' + k), 4)
    def num(v, d=0.0):
        try: return round(float(v), 3)
        except Exception: return d

    site, cover, eco, clim = [], [], [], []
    for x in st:
        m = _m(x)
        site.append([x['name'], x.get('en', ''), x['lon'], x['lat'], num(eff_val(x, 'elev')),
                     x.get('type', ''), x.get('zone', '')])
        cover.append([x['name'], lc(x, '林地'), lc(x, '草地灌丛'), lc(x, '农田'),
                      lc(x, '建成区'), lc(x, '裸地'), lc(x, '水体'), lc(x, '湿地')])
        eco.append([x['name'], round(m['fvc'], 3), round(m['carbon'], 2), round(m['slide'], 2),
                    round(m['deg'], 2), round(m['risk'], 2), round(m['ei'], 2), _grade(m['eei'])])
        ys = (climate().get('stations', {}).get(x['name']) or {}).get('years') or []
        if ys:
            t_m = eff_val(x, 'temp') if ('temp' in ov_of(x['name'])) else sum(r[1] for r in ys) / len(ys)
            p_m = eff_val(x, 'precip') if ('precip' in ov_of(x['name'])) else sum(r[2] for r in ys) / len(ys)
            et_m = sum(r[3] for r in ys) / len(ys)
            clim.append([x['name'], round(t_m, 2), round(p_m, 1), round(et_m, 1),
                         round(et_m / p_m, 2) if p_m else None])
        else:
            clim.append([x['name'], None, None, None, None])
    ledger = [
        ['高程 DEM', 'Terrarium / SRTM（AWS Open Data）', '30 m→740 m', '开放'],
        ['卫星影像', 'Esri World Imagery', '≈380 m/px', '研究用途'],
        ['土地覆盖', 'Sentinel-2 10 m LULC（Impact Observatory/Esri）', '10 m', 'CC BY 4.0'],
        ['水系', 'DEM 洼地填充 + D8 汇流累积提取', '—', '派生'],
        ['气候', 'NASA POWER · MERRA-2 再分析（2000–2024）', '0.5°×0.625°', '开放'],
        ['站点属性', '野外记录 + DEM 双线性采样', '20 站', '实测/派生'],
        ['评估指标', '按 HJ 192—2015 框架派生', '20 站', '估算'],
        ['人工修正 / 追加观测', '专家复核与会商补测，覆盖层 + 变更台账，可撤销', '站点级', '人工'],
    ]
    # 气候年值 / 气候趋势：来自 NASA POWER 2000–2024 实测序列
    cy, tr = [], []
    for name, s in (climate().get('stations') or {}).items():
        ys = s.get('years') or []
        for r in ys:
            cy.append([name, r[0], r[1], r[2], r[3]])
        if len(ys) >= 3:
            xs = [r[0] for r in ys]
            st10 = _slope(xs, [r[1] for r in ys]) * 10                 # ℃/10a
            sp10 = _slope(xs, [r[2] for r in ys]) * 10                 # mm/10a
            pm = sum(r[2] for r in ys) / len(ys)
            tr.append([name, xs[0], xs[-1], round(st10, 3),
                       round(sp10 / pm * 100, 2) if pm else None])
    return [
        {'table': '站点', 'columns': ['名称', '英文', '经度', '纬度', '海拔', '类型', '分区'], 'rows': site},
        {'table': '土地覆盖', 'columns': ['站点', '林地', '草地灌丛', '农田', '建成区', '裸地', '水体', '湿地'],
         'rows': cover},
        {'table': '生态指标', 'columns': ['站点', '植被覆盖FVC', '碳密度', '滑坡敏感性', '退化风险',
                                          '综合风险', '生态指数EI', '等级'], 'rows': eco},
        {'table': '气候', 'columns': ['站点', '多年年均温', '多年年降水', '多年年蒸散', '干燥指数'],
         'rows': clim},
        {'table': '气候年值', 'columns': ['站点', '年份', '年均温', '年降水', '年蒸散'], 'rows': cy},
        {'table': '气候趋势', 'columns': ['站点', '起始年', '终止年', '升温速率', '降水变化率'],
         'rows': tr},
        {'table': '数据来源台账', 'columns': ['数据集', '来源', '分辨率', '许可'], 'rows': ledger},
        {'table': '区域', 'columns': ['区域', '类型', '站点数', '已修正站', '平均EEI', '平均风险'],
         'rows': _region_rows()},
        {'table': '数据修正台账', 'columns': ['编号', '时间', '操作人', '类型', '区域', '字段', '方式',
                                            '数值', '影响站数', '原因', '来源', '已撤销'],
         'rows': _change_rows()},
        {'table': '观测台账', 'columns': ['编号', '站点', '字段', '数值', '单位', '时间', '来源', '已生效'],
         'rows': _obs_rows()},
    ]

def _region_rows():
    rows = []
    for d in region_defs():
        sts, _ = region_stations(d['id'])
        if not sts: continue
        m = region_means(sts)
        ed = sum(1 for s in sts if ov_of(s['name']))
        rows.append([d['name'], {'basin': '全流域', 'seg': '河段', 'zone': '分区',
                                 'custom': '框选'}.get(d['kind'], d['kind']),
                     len(sts), ed, m.get('eei'), m.get('risk')])
    return rows

def _change_rows():
    kmap = {'adjust': '区域调数', 'correct': '单站修正', 'reset': '区域回退', 'observe': '追加观测'}
    omap = {'set': '设为', 'scale': '乘以', 'offset': '加上'}
    return [[c['id'], c['t'], c.get('user', ''), kmap.get(c['kind'], c['kind']),
             c.get('regionName', ''), c.get('fieldNm', c.get('field', '')),
             omap.get(c.get('op'), c.get('op', '')), c.get('value'),
             c.get('n', ''), (c.get('reason') or '')[:40], c.get('source', ''),
             '是' if c.get('undone') else '否'] for c in gov()['changes'][-60:][::-1]]

def _obs_rows():
    return [[o['id'], o.get('station', ''), o.get('fieldNm', o.get('field', '')), o.get('value'),
             o.get('unit', ''), o.get('t', ''), o.get('source', ''),
             '是' if o.get('applied') else '否'] for o in gov()['observations'][-60:][::-1]]

def db_schema():
    return [{'table': t['table'], 'rows': len(t['rows']),
             'columns': [{'name': c} for c in t['columns']]} for t in _db_tables()]

def db_query(sql):
    """极简只读 SQL：SELECT 列 FROM 表 [WHERE 条件 [AND 条件]] [ORDER BY 列 [DESC]] [LIMIT n]。
    只做这一种形态，够智能体「查数据库」演示用；不做聚合、子查询、JOIN，避免变成半吊子 SQL 引擎。"""
    t0 = time.time()
    sql = (sql or '').strip()
    if len(sql) > 2000:
        return None, 'SQL 过长'
    if not re.match(r'(?is)^select\b', sql):
        return None, '只允许 SELECT 查询'
    s = sql.rstrip(';').strip()
    tabs = {t['table']: t for t in _db_tables()}

    def cut(text, kw):
        i = text.lower().find(' ' + kw + ' ')
        if i < 0: return text, None
        return text[:i].strip(), text[i + len(kw) + 2:].strip()

    i_from = s.lower().find(' from ')
    if i_from < 0: return None, '缺少 FROM'
    cols_part, rest = s[6:i_from].strip(), s[i_from + 6:].strip()

    limit = 50
    rest, lim = cut(rest, 'limit')
    if lim:
        m = re.search(r'\d+', lim)
        limit = min(500, int(m.group())) if m else 50
    rest, order = cut(rest, 'order by')
    rest, group = cut(rest, 'group by')
    rest, where = cut(rest, 'where')
    table = rest.strip().strip('"`\'')
    t = tabs.get(table)
    if not t: return None, '未知表：%s（可用：%s）' % (table, '、'.join(tabs))

    def val(expr):
        expr = expr.strip()
        if len(expr) > 1 and expr[0] == expr[-1] and expr[0] in ('"', "'"):
            return expr[1:-1]
        try: return float(expr)
        except Exception: return expr

    conds = []
    if where:
        for part in re.split(r'(?i)\s+and\s+', where):
            m = re.match(r'^\s*"?([^"<>=!]+?)"?\s*(>=|<=|!=|<>|=|>|<|like)\s*(.+)$', part.strip(), re.I)
            if not m: return None, '无法解析条件：%s' % part.strip()
            conds.append((m.group(1).strip(), m.group(2).lower(), val(m.group(3))))

    names = t['columns']
    recs = [dict(zip(names, r)) for r in t['rows']]

    def resolve(col):
        """站名列在不同表里叫「名称」或「站点」，统一做一次别名映射，避免模型写错就查不到。"""
        if col in names: return col
        alias = {'名称': '站点', '站名': '站点', '站点': '名称'}
        alt = alias.get(col)
        return alt if alt in names else None

    def hit(rec):
        for col, op, v in conds:
            col = resolve(col)
            if not col: return False
            a = rec[col]
            if op == 'like':
                if str(v).strip('%').lower() not in str(a).lower(): return False
                continue
            if isinstance(v, float):
                try: a = float(a)
                except Exception: return False
                if op == '=' and a != v: return False
                if op in ('!=', '<>') and a == v: return False
                if op == '>' and not a > v: return False
                if op == '<' and not a < v: return False
                if op == '>=' and not a >= v: return False
                if op == '<=' and not a <= v: return False
            else:
                if op == '=' and str(a) != str(v): return False
                if op in ('!=', '<>') and str(a) == str(v): return False
        return True

    rows = [r for r in recs if hit(r)]

    c = cols_part.strip()
    parts = [x.strip() for x in c.split(',')]
    agg = None
    if parts and re.match(r'(?is)^count\s*\(\s*\*\s*\)', parts[-1]):
        agg = re.match(r'(?is)^count\s*\(\s*\*\s*\)(?:\s*::\s*\w+)?(?:\s+as\s+(\S+))?$', parts[-1])
        if not agg: return None, '聚合写法不支持：%s' % parts[-1]
    if agg:
        alias = (agg.group(1) or '计数').strip('"`\'')
        if group:
            gcol = resolve(group.split()[0].strip().strip('"`\''))
            if not gcol: return None, '分组字段不存在：%s（可用：%s）' % (group, '、'.join(names))
            cnt = {}
            for r in rows:
                cnt[r[gcol]] = cnt.get(r[gcol], 0) + 1
            cols, out = [gcol, alias], [[k, v] for k, v in cnt.items()]
        elif len(parts) == 1:
            cols, out = [alias], [[len(rows)]]
        else:
            return None, 'SELECT 里有普通列时必须配 GROUP BY'
    elif group:
        return None, 'GROUP BY 目前只支持配合 COUNT(*) 使用'
    else:
        cols, out = None, None

    if cols is None:
        if order:
            ocol = resolve(order.split()[0].strip().strip('"`\''))
            desc = len(order.split()) > 1 and order.split()[1].lower().startswith('desc')
            if not ocol: return None, '排序字段不存在：%s（可用：%s）' % (order.split()[0], '、'.join(names))
            def key(r):
                v = r[ocol]
                return (0, v) if isinstance(v, (int, float)) else (1, str(v))
            rows.sort(key=key, reverse=desc)
        if c == '*':
            cols, out = names, [[r[n] for n in names] for r in rows]
        else:
            want = [x.strip().strip('"`\'') for x in c.split(',')]
            cols = [resolve(x) for x in want]
            bad = [w for w, r in zip(want, cols) if not r]
            if bad: return None, '未知列：%s（可用：%s）' % ('、'.join(bad), '、'.join(names))
            out = [[r[n] for n in cols] for r in rows]
    elif order:
        ocol = order.split()[0].strip().strip('"`\'')
        desc = len(order.split()) > 1 and order.split()[1].lower().startswith('desc')
        if ocol in cols:
            oi = cols.index(ocol)
            out.sort(key=lambda r: (0, r[oi]) if isinstance(r[oi], (int, float)) else (1, str(r[oi])),
                     reverse=desc)

    return {'ok': True, 'columns': cols, 'rows': out[:limit], 'count': len(out[:limit]),
            'ms': int((time.time() - t0) * 1000), 'sql': s}, None

# ------------------------------------------------------------------ 项目文件（只读）
SKIP_DIRS = {'node_modules', '.git', '__pycache__', '.workbuddy-ai', '.workbuddy', 'bin'}
TEXT_EXT = {'.py', '.js', '.css', '.html', '.json', '.md', '.txt', '.cmd', '.bat', '.yml', '.yaml', '.csv'}

def fs_tree(depth=2):
    def walk(d, lv):
        items = []
        try: names = sorted(os.listdir(d))
        except Exception: return items
        for n in names:
            if n.startswith('.') or n in SKIP_DIRS or n == 'users.json': continue
            p = os.path.join(d, n)
            if os.path.isdir(p):
                node = {'name': n, 'type': 'dir'}
                if lv < depth: node['children'] = walk(p, lv + 1)
                items.append(node)
            elif os.path.splitext(n)[1].lower() in TEXT_EXT and os.path.getsize(p) < 2 * 1024 * 1024:
                items.append({'name': n, 'type': 'file', 'size': os.path.getsize(p)})
        return items
    return walk(ROOT, 0)

def fs_read(path):
    rel = (path or '').replace('\\', '/').strip().lstrip('/')
    full = os.path.normpath(os.path.join(ROOT, rel))
    if not full.startswith(ROOT + os.sep):
        return None, '只能读取项目目录内的文件'
    base = os.path.basename(full)
    if base.startswith('.') or base in ('users.json',):
        return None, '该文件不允许读取'
    if os.path.splitext(full)[1].lower() not in TEXT_EXT:
        return None, '只支持文本类文件'
    if not os.path.isfile(full):
        return None, '文件不存在：%s' % rel
    if os.path.getsize(full) > 2 * 1024 * 1024:
        return None, '文件过大（>2 MB）'
    with open(full, encoding='utf-8', errors='replace') as f:
        lines = f.read().splitlines()
    head = '\n'.join(lines[:200])
    return {'ok': True, 'path': rel, 'lines': len(lines), 'head': head,
            'truncated': len(lines) > 200}, None



def report_html():
    st = load_json(STATIONS, {'stations': []})['stations']
    meta = load_json(os.path.join(DATA, 'meta.json'), {})
    items = [(x, eco_item(x)) for x in st]
    n = len(items) or 1
    ei = sum(i[1]['eei'] for i in items) / n
    rk = sum(_m(x)['risk'] for x, _ in items) / n
    hi = sum(1 for x, _ in items if _m(x)['risk'] >= 58)
    mid = sum(1 for x, _ in items if 45 <= _m(x)['risk'] < 58)
    lo = n - hi - mid
    carbon = sum(_m(x)['carbon'] for x, _ in items) / n
    fvc = sum(_m(x)['fvc'] for x, _ in items) / n
    grade = 'A' if ei >= 75 else 'B' if ei >= 65 else 'C' if ei >= 55 else 'D'
    gname = {'A': '优', 'B': '良', 'C': '一般', 'D': '较差'}[grade]

    rows = []
    for x, it in sorted(items, key=lambda t: -t[1]['eei']):
        m = _m(x)
        rows.append(
            '<tr><td class="l">%s</td><td>%s</td><td class="n">%s</td><td class="n">%.1f</td>'
            '<td class="n">%.0f</td><td class="n">%.0f</td><td class="n">%.1f</td>'
            '<td class="n b">%.1f</td><td class="c">%s</td><td class="n">%.0f</td><td class="c">%s</td></tr>' % (
                x['name'], x.get('zone', ''), round(eff_val(x, 'elev')), eff_val(x, 'slope'),
                _f(x, '林地') * 100, m['fvc'] * 100, m['carbon'], it['eei'], it['grade'],
                m['risk'], '高' if m['risk'] >= 58 else ('中' if m['risk'] >= 45 else '低')))

    def bar(label, val, maxv, color):
        w = max(2, min(100, val / maxv * 100))
        return ('<div class="bar"><span class="bl">%s</span><span class="bt"><i style="width:%.1f%%;background:%s"></i></span>'
                '<span class="bv">%s</span></div>' % (label, w, color, val))

    dist = ('<div class="bar"><span class="bl">高风险</span><span class="bt"><i style="width:%.0f%%;background:#d9534f"></i></span>'
            '<span class="bv">%d 站</span></div>' % (hi / n * 100, hi) +
            '<div class="bar"><span class="bl">中风险</span><span class="bt"><i style="width:%.0f%%;background:#e0a33a"></i></span>'
            '<span class="bv">%d 站</span></div>' % (mid / n * 100, mid) +
            '<div class="bar"><span class="bl">低风险</span><span class="bt"><i style="width:%.0f%%;background:#3aa675"></i></span>'
            '<span class="bv">%d 站</span></div>' % (lo / n * 100, lo))

    return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>金沙江流域森林生态环境评估报告</title>
<style>
@page{size:A4;margin:16mm 14mm}
*{box-sizing:border-box}
body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#1c2a2e;margin:0;background:#eef2f1}
.page{width:210mm;min-height:297mm;margin:0 auto;background:#fff;padding:16mm 14mm}
h1{font-size:20px;margin:0 0 4px;letter-spacing:1px}
.sub{font-size:11px;color:#6b7f83;letter-spacing:1px}
.meta{display:flex;gap:18px;font-size:10.5px;color:#5d7276;margin-top:10px;border-bottom:2px solid #14343a;padding-bottom:8px}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0 6px}
.k{border:1px solid #d8e2e0;border-radius:6px;padding:10px 12px}
.k .t{font-size:10px;color:#6b7f83}
.k .v{font-size:24px;font-weight:600;color:#14343a;margin-top:2px}
.k .v small{font-size:11px;font-weight:400;color:#6b7f83;margin-left:3px}
h2{font-size:13px;margin:18px 0 8px;padding-left:8px;border-left:3px solid #2b8f76}
table{width:100%%;border-collapse:collapse;font-size:10px}
th{background:#f0f5f4;color:#3d565b;font-weight:600;text-align:left;padding:5px 4px;border-bottom:1px solid #cfdad8}
td{padding:4px;border-bottom:1px solid #eef2f1}
td.n{font-family:Consolas,monospace;text-align:right}
td.c{text-align:center}
td.b{font-weight:600}
td.l{font-weight:600}
tr:nth-child(even) td{background:#fafcfc}
.bar{display:flex;align-items:center;gap:8px;margin:5px 0;font-size:10px}
.bl{width:64px;color:#4a6166}
.bt{flex:1;height:7px;background:#eef2f1;border-radius:4px;overflow:hidden}
.bt i{display:block;height:100%%;border-radius:4px}
.bv{width:56px;text-align:right;font-family:Consolas,monospace;color:#14343a}
.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.note{font-size:9.5px;line-height:1.8;color:#5d7276;background:#f7faf9;border:1px solid #e3ebe9;border-radius:6px;padding:10px 12px}
.print{position:fixed;right:24px;top:20px;background:#14343a;color:#fff;border:0;border-radius:6px;
 padding:9px 16px;font-size:12px;cursor:pointer}
@media print{body{background:#fff}.page{width:auto;min-height:auto;margin:0;padding:0}.print{display:none}}
</style></head><body>
<button class="print" onclick="window.print()">打印 / 保存为 PDF</button>
<div class="page">
  <h1>金沙江流域森林生态环境评估报告</h1>
  <div class="sub">JINSHA RIVER FOREST ECOLOGY · ASSESSMENT REPORT</div>
  <div class="meta"><span>生成时间：%s</span><span>数据版本：%s</span><span>监测站点：%d</span><span>数据来源：DEM / Sentinel-2 10m / World Imagery</span></div>

  <div class="kpis">
    <div class="k"><div class="t">生态环境状况指数 EI</div><div class="v">%.1f<small>%s</small></div></div>
    <div class="k"><div class="t">平均综合风险 R</div><div class="v">%.0f<small>/100</small></div></div>
    <div class="k"><div class="t">平均植被覆盖度</div><div class="v">%.0f<small>%%</small></div></div>
    <div class="k"><div class="t">平均碳密度</div><div class="v">%.1f<small>tC/ha</small></div></div>
  </div>

  <div class="two">
    <div><h2>风险等级分布</h2>%s</div>
    <div><h2>分项指数</h2>%s</div>
  </div>

  <h2>站点评估明细</h2>
  <table><thead><tr><th>站点</th><th>分区</th><th>海拔/m</th><th>坡度/°</th><th>林地/%%</th>
  <th>覆盖/%%</th><th>碳密度</th><th>EI</th><th>等级</th><th>风险</th><th>等级</th></tr></thead>
  <tbody>%s</tbody></table>

  <h2>方法与口径</h2>
  <div class="note">
    1. 地形与坡度：Terrarium/SRTM 30 m 高程重采样，双线性采样；水系由洼地填充 + D8 汇流累积提取。<br>
    2. 土地覆盖：Sentinel-2 10 m 土地覆盖产品（Impact Observatory / Esri），5 km 缓冲统计各类型占比。<br>
    3. 生态环境状况指数：参照 HJ 192—2015 框架，EI =（0.35·ABI + 0.25·VCI + 0.15·WRI + 0.15·(100−LSI)）/ 0.90；
       污染负荷项因缺数据未纳入，结果仅在本研究内部可比。<br>
    4. 综合风险：R = 0.42·滑坡敏感性 + 0.33·退化风险 + 0.25·土地胁迫；分级阈值 58 / 45。<br>
    5. 局限：植被覆盖、碳密度、滑坡敏感性为土地覆盖与地形推算的估算值，非样地实测；
       气候为参考值，尚未接入 ERA5-Land 逐日序列；机器学习模型因缺标注样本未参与计算。
  </div>

  <h2>数据修正与观测补录</h2>
  <div class="note">%s</div>
</div></body></html>""" % (
        time.strftime('%Y-%m-%d %H:%M'), meta.get('version', '—'), n, ei, gname, rk, fvc * 100, carbon,
        dist, bar('生物丰度', sum(_m(x)['abi'] for x, _ in items) / n, 60, '#2b8f76') +
        bar('植被覆盖', fvc * 100, 90, '#3aa675') +
        bar('水网密度', sum(_m(x)['wri'] for x, _ in items) / n, 80, '#4a8fb8') +
        bar('土地胁迫', sum(_m(x)['lsi'] for x, _ in items) / n, 60, '#c9a227'),
        ''.join(rows), gov_note())

def gov_note():
    """报告用：把人工修正与追加观测写进正文，避免「数字对不上」时无法解释。"""
    ovs = gov()['overrides']
    chs = gov()['changes']
    obs = gov()['observations']
    if not ovs and not obs:
        return '本期未发生人工修正，全部指标直接来自原始观测与再分析数据。'
    parts = []
    if ovs:
        parts.append('截至出报告时刻，<b>%d</b> 个站点的 <b>%d</b> 项数值经人工复核修正；'
                     '修正不覆盖原始观测，全部记入变更台账，可逐条撤销。'
                     % (len(ovs), sum(len(v) for v in ovs.values())))
        for c in chs[-6:][::-1]:
            parts.append('· %s　%s　%s = %s　影响 %s 站　原因：%s' % (
                c['t'], c.get('regionName', ''), c.get('fieldNm', ''), c.get('value', ''),
                c.get('n', ''), c.get('reason', '')))
    if obs:
        parts.append('另有 <b>%d</b> 条追加观测（来源：%s）已登记，其中 %d 条作为当前有效值。' % (
            len(obs), '、'.join(sorted({o.get('source', '手工') for o in obs})),
            sum(1 for o in obs if o.get('applied'))))
    return '<br>'.join(parts)

def gov_csv():
    """治理台账导出：一条变更一行，可直接作为答辩附件（谁、何时、改了哪个站哪个字段、为什么）。"""
    buf = io.StringIO(); w = csv.writer(buf)
    w.writerow(['编号', '时间', '操作人', '类型', '区域', '字段', '方式', '数值', '影响站数',
                '原因', '数据来源', '调整前EEI', '调整后EEI', '是否撤销'])
    kmap = {'adjust': '区域调数', 'correct': '单站修正', 'reset': '区域回退', 'observe': '追加观测'}
    omap = {'set': '设为', 'scale': '乘以', 'offset': '加上'}
    for c in gov()['changes'][::-1]:
        b, a = c.get('before') or {}, c.get('after') or {}
        w.writerow([c['id'], c['t'], c.get('user', ''), kmap.get(c['kind'], c['kind']),
                    c.get('regionName', ''), c.get('fieldNm', c.get('field', '')),
                    omap.get(c.get('op'), c.get('op', '')), c.get('value'), c.get('n', ''),
                    c.get('reason', ''), c.get('source', ''), b.get('eei', ''), a.get('eei', ''),
                    '是' if c.get('undone') else '否'])
    return ('\ufeff' + buf.getvalue()).encode('utf-8')

def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.connect(('8.8.8.8', 80))
        ips.add(s.getsockname()[0]); s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith('127.'): ips.add(ip)
    except Exception:
        pass
    return sorted(ips)

def main():
    global HOST, PORT
    args = sys.argv[1:]
    if '--set-password' in args:
        u = input('用户名 [admin]: ').strip() or 'admin'
        p = input('新密码: ').strip()
        print('已修改' if p and set_password(u, p) else '用户不存在或密码为空')
        return
    if '--port' in args: PORT = int(args[args.index('--port') + 1])
    elif os.environ.get('PORT'): PORT = int(os.environ['PORT'])
    if '--host' in args: HOST = args[args.index('--host') + 1]

    os.makedirs(DATA, exist_ok=True)
    init_users()
    _auto_sync_start()
    srv = ThreadingHTTPServer((HOST, PORT), H)
    srv.daemon_threads = True
    print('\n' + '─' * 62)
    print('  金沙江流域森林生态环境智能评估系统  v2.0')
    print('─' * 62)
    print('  本机访问   http://127.0.0.1:%d' % PORT)
    for ip in lan_ips():
        print('  局域网访问 http://%s:%d' % (ip, PORT))
    print('  账号       why（密码不在此处回显，可在「设置 → 修改密码」更换）')
    print('  停止服务   Ctrl + C')
    print('─' * 62 + '\n', flush=True)
    try: srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')

if __name__ == '__main__':
    main()
