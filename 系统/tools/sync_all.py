# -*- coding: utf-8 -*-
"""定时同步入口（同学丙 任务三-2）：一键更新土地利用/灯光/人口并质检。

默认跑可靠的 GEE 通道（夜间灯光 + 人口 + MODIS 土地利用），CLCD 30m 需手动单独跑
（依赖 Zenodo 远程读取或整年下载）。Moran/LISA 较慢，默认不跑，用 --moran 开启。

用法：
  python tools/sync_all.py            # 灯光 + 人口 + MODIS 土地利用 + 质检
  python tools/sync_all.py --lulc-source clcd --lulc-years 2020   # 指定 CLCD
  python tools/sync_all.py --moran --years 1990,2000,2010,2020    # 加空间自相关
"""
import argparse
import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable or 'python'


def run(script, *args):
    cmd = [PY, os.path.join(ROOT, 'tools', script)] + list(args)
    print('\n===== %s %s =====' % (script, ' '.join(args)))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print('[!] %s 失败（exit %d）' % (script, r.returncode))
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--lulc-source', default='gee', choices=['gee', 'clcd'])
    ap.add_argument('--lulc-years', default=None)
    ap.add_argument('--moran', action='store_true')
    ap.add_argument('--years', default='1990,2000,2010,2020')
    args = ap.parse_args()

    ok = True
    ok &= run('nightlight_gee.py', '--include-dmsp')
    ok &= run('population_gee.py')
    lulc_args = ['--source', args.lulc_source]
    if args.lulc_years:
        lulc_args += ['--years', args.lulc_years]
    ok &= run('lulc_clcd.py', *lulc_args)
    if args.moran:
        ok &= run('moran_lisa.py', '--years', args.years)
    run('quality_check.py')
    print('\n同步完成（%s）' % ('全部成功' if ok else '有步骤失败，见上方日志'))


if __name__ == '__main__':
    main()
