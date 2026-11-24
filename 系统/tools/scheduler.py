# -*- coding: utf-8 -*-
"""注册/查看/删除 定时同步任务（同学丙 任务三-2）。

Windows：用 schtasks 注册每日任务；Linux/macOS：打印 crontab 行。
通过 subprocess 传参（Python 处理中文路径，避免 .bat 编码乱码）。

用法：
  python tools/scheduler.py --install --time 03:00     # Windows 注册每日 03:00 同步
  python tools/scheduler.py --show                      # 查看已注册任务
  python tools/scheduler.py --remove                    # 删除任务
  python tools/scheduler.py --cron                      # 打印 Linux crontab 行
"""
import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC = os.path.join(ROOT, 'tools', 'sync_all.py')
PY = sys.executable or 'python'
TASK_NAME = 'Jinsha_Daily_Sync'


def _schtasks(args):
    return subprocess.run(['schtasks'] + args, capture_output=True, text=True,
                          encoding='gbk', errors='replace')


def install(hhmm):
    # /TR 的命令：python sync_all.py（中文路径由 CreateProcessW 安全传递）
    cmd = '"%s" "%s"' % (PY, SYNC)
    r = _schtasks(['/Create', '/SC', 'DAILY', '/TN', TASK_NAME,
                   '/TR', cmd, '/ST', hhmm, '/F'])
    print(r.stdout or r.stderr)
    if r.returncode == 0:
        print('已注册每日任务 %s，触发时间 %s' % (TASK_NAME, hhmm))
        print('注意：脚本写云库，无需额外环境变量（连接串内置兜底）。')


def show():
    r = _schtasks(['/Query', '/TN', TASK_NAME, '/V', '/FO', 'LIST'])
    print(r.stdout or r.stderr)


def remove():
    r = _schtasks(['/Delete', '/TN', TASK_NAME, '/F'])
    print(r.stdout or r.stderr)


def cron():
    print('# crontab 追加（Linux/macOS），每日 03:00 同步：')
    print('0 3 * * * %s %s >> %s 2>&1' % (PY, SYNC, os.path.join(ROOT, 'data', 'sync.log')))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--install', action='store_true')
    ap.add_argument('--show', action='store_true')
    ap.add_argument('--remove', action='store_true')
    ap.add_argument('--cron', action='store_true')
    ap.add_argument('--time', default='03:00')
    args = ap.parse_args()

    if sys.platform.startswith('win'):
        if args.install:
            install(args.time)
        elif args.show:
            show()
        elif args.remove:
            remove()
        else:
            cron()
    else:
        cron()


if __name__ == '__main__':
    main()
