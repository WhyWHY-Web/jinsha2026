# -*- coding: utf-8 -*-
"""
跨语言一致性回归：Python 指标引擎 ↔ 前端 metrics.js。

为什么需要
  老师点名的一个优点就是「三处同源算法 + 跨语言一致性测试锁住」：
  同一个站，页面评分、情景推演、智能体回答必须给出同一个数。
  本项目后端是 server.py:_m()，前端离线/推演时用 web/assets/metrics.js，
  两套实现一旦漂移，答辩现场就会出现"两个数打架"。

做什么
  用 20 个真实站点（含人工修正后的有效值）作为输入，分别跑 Python 与 Node，
  逐字段比对 18 个输出量，误差超过 1e-9 即判失败，并打印差异最大的字段。

用法
  python tools/test_consistency.py
  python tools/test_consistency.py --tol 1e-6
退出码
  0 一致；1 不一致；2 环境缺 node
"""
import argparse, json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server as S  # noqa: E402

KEYS = ['fvc', 'carbon', 'slide', 'deg', 'lsi', 'abi', 'wri', 'ei', 'risk',
        'habitat', 'biodiversity', 'water', 'soil', 'climate', 'resilience',
        'esv', 'disturbance', 'eei']

NODE_SNIPPET = r"""
const M = require(process.argv[1]);
const cases = require(process.argv[2]);
const out = cases.map(function (c) {
  const r = M.m(c.in);
  const o = {};
  Object.keys(c.out).forEach(function (k) { o[k] = r[k]; });
  return o;
});
process.stdout.write(JSON.stringify(out));
"""


def build_cases():
    cases = []
    for st in S.all_stations():
        inp = {
            'f': S._f(st, '林地'), 'g': S._f(st, '草地灌丛'), 'c': S._f(st, '农田'),
            'b': S._f(st, '建成区'), 'ba': S._f(st, '裸地'),
            'w': S._f(st, '水体'), 'we': S._f(st, '湿地'),
            'slope': S.eff_val(st, 'slope'), 'relief': float(st.get('relief') or 0),
            'P': S.eff_val(st, 'precip'), 'T': S.eff_val(st, 'temp'),
        }
        m = S._m(st)
        cases.append({'name': st['name'], 'in': inp, 'out': {k: round(float(m[k]), 12) for k in KEYS}})
    return cases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--tol', type=float, default=1e-9)
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    try:
        subprocess.run(['node', '--version'], capture_output=True, check=True)
    except Exception:
        print('缺少 node，无法做跨语言比对'); return 2

    mjs = os.path.join(ROOT, 'web', 'assets', 'metrics.js')
    if not os.path.isfile(mjs):
        print('缺少 web/assets/metrics.js'); return 2

    cases = build_cases()
    tmp = tempfile.mkdtemp(prefix='jinsha-consist-')
    cpath = os.path.join(tmp, 'cases.json')
    json.dump(cases, open(cpath, 'w', encoding='utf-8'), ensure_ascii=False)
    r = subprocess.run(['node', '-e', NODE_SNIPPET, mjs, cpath], capture_output=True, text=True)
    if r.returncode != 0:
        print('node 执行失败：\n' + (r.stderr or '')[:800]); return 1
    js = json.loads(r.stdout)

    worst, bad = (0.0, '', ''), []
    for c, j in zip(cases, js):
        for k in KEYS:
            py, jv = c['out'][k], float(j[k])
            d = abs(py - jv)
            rel = d / max(abs(py), 1e-12)
            if rel > worst[0]:
                worst = (rel, c['name'] + '.' + k, 'py=%.12f js=%.12f' % (py, jv))
            if rel > a.tol:
                bad.append((c['name'], k, py, jv, rel))

    print('比对 %d 站 × %d 个指标 = %d 个数值，容差 %.0e' % (len(cases), len(KEYS), len(cases) * len(KEYS), a.tol))
    if bad:
        print('差异 %d 处：' % len(bad))
        for nm, k, py, jv, rel in bad[:20]:
            print('  %-6s %-14s py=%.9f  js=%.9f  相对差 %.1e' % (nm, k, py, jv, rel))
        print('最大相对差：%s  %s  %s' % (worst[1], '%.3e' % worst[0], worst[2]))
        return 1
    print('一致 ✓  最大相对差 %.2e（%s）' % (worst[0], worst[1]))
    if a.verbose:
        for c, j in zip(cases[:3], js[:3]):
            print('  %s  EI=%.3f  R=%.2f  EEI=%.1f' % (c['name'], j['ei'], j['risk'], j['eei']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
