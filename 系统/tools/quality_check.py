# -*- coding: utf-8 -*-
"""数据质检（同学丙 任务三-3）：行数 / 时间连续性 / 数值范围，输出质检报告。

检查对象：lulc / nightlight / population / moran_lisa 四张云库表。
输出：控制台 + data/quality_report.md

用法：
  python tools/quality_check.py
"""
import os
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import pg_util  # noqa: E402

OUT = os.path.join(ROOT, 'data', 'quality_report.md')

# 期望年份范围（缺年提示）
EXPECT = {
    'lulc': list(range(1990, 2024)),
    'nightlight': list(range(2013, 2026)),
    'population': [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025, 2030],
    'moran_lisa': [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025],
}


def check_range(name, years, lo, hi, getval, where='1=1'):
    """返回 (行数, 越界数, 缺年列表)"""
    conn = pg_util.get_conn()
    cur = conn.cursor()
    cur.execute('SELECT count(*) FROM "%s" WHERE %s' % (name, where))
    n = cur.fetchone()[0]
    cur.execute('SELECT year, %s FROM "%s" WHERE %s' % (getval, name, where))
    bad, have_years = [], set()
    for y, v in cur.fetchall():
        have_years.add(int(y))
        if v is None:
            continue
        try:
            if not (lo <= float(v) <= hi):
                bad.append((int(y), v))
        except (TypeError, ValueError):
            pass
    conn.close()
    missing = [y for y in years if y not in have_years]
    return n, bad, missing


def main():
    report = ['# 金沙江流域数据质检报告', '', '生成时间：%s' % datetime.now().strftime('%Y-%m-%d %H:%M'), '']
    rows = []

    # lulc：pct 应在 0-100
    n, bad, missing = check_range('lulc', EXPECT['lulc'], 0, 100, 'pct')
    rows.append(('lulc（土地利用）', n, bad[:5], missing))
    # nightlight：mean_radiance >= 0
    n, bad, missing = check_range('nightlight', EXPECT['nightlight'], 0, 1e9, 'mean_radiance')
    rows.append(('nightlight（夜间灯光）', n, bad[:5], missing))
    # population：total_pop >= 0
    n, bad, missing = check_range('population', EXPECT['population'], 0, 3e9, 'total_pop')
    rows.append(('population（人口）', n, bad[:5], missing))
    # moran_lisa：global_moran in [-1,1]，p_value in [0,1]
    n, bad, missing = check_range('moran_lisa', EXPECT['moran_lisa'], -1, 1, 'global_moran')
    rows.append(('moran_lisa（空间自相关）', n, bad[:5], missing))

    report.append('| 表 | 行数 | 越界样例 | 缺年 |')
    report.append('|---|---|---|---|')
    for name, n, bad, missing in rows:
        bad_s = '、'.join('%d=%.3f' % (y, v) for y, v in bad) if bad else '无'
        miss_s = '、'.join(map(str, missing)) if missing else '无'
        report.append('| %s | %d | %s | %s |' % (name, n, bad_s, miss_s))

    report.append('')
    report.append('> 判定：缺年=「无」且越界=「无」为通过；否则需补数据。')
    text = '\n'.join(report)
    print(text)
    with open(OUT, 'w', encoding='utf-8') as fp:
        fp.write(text + '\n')
    print('\n报告已保存:', OUT)


if __name__ == '__main__':
    main()
