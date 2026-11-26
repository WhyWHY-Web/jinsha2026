"""生态指标与水文统计公式。数据读取和治理修正由调用方负责。"""
import math


def station_metrics(st, effective, T_ov=None, P_ov=None, *, cover=None):
    fields = ('林地', '草地灌丛', '农田', '建成区', '裸地', '水体', '湿地')
    f, g, c, b, ba, w, we = (float(cover[k]) if cover is not None else effective(st, 'lc.' + k) for k in fields)
    # 气候优先用 NASA POWER 2000–2024 实测序列均值；有人工修正时以修正值为准（台账留痕）。
    # T_ov / P_ov 用于「时间轴」：传入某一年的实测气候，其余输入保持不变，得到该年的指标。
    P = float(P_ov) if P_ov is not None else effective(st, 'precip')
    T = float(T_ov) if T_ov is not None else effective(st, 'temp')
    slope = effective(st, 'slope')
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
