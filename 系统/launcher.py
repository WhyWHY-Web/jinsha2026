# -*- coding: utf-8 -*-
"""
金沙江生态智能评估 · 桌面版启动器（打包成 exe 的入口）

双击 exe 后：
  1. 首次运行把内置数据（站点、DEM、气候序列、账号）复制到 %LOCALAPPDATA%\\JinshaEco\\data
  2. 在后台启动 HTTP 服务
  3. 自动打开浏览器进入登录页
  4. 关闭窗口（或 Ctrl+C）即停止服务

数据为什么放在 %LOCALAPPDATA%：
  PyInstaller 单文件 exe 每次运行都会解包到临时目录，程序目录里的文件改了就丢。
  账号、新增站点、审计日志必须放在固定可写位置，下次打开还在。
"""
import os
import shutil
import socket
import sys
import threading
import time
import webbrowser

APP_NAME = 'JinshaEco'
SEED_FILES = ['dem.bin', 'dem256.bin', 'streams.json', 'hydro.json', 'stations.json',
              'climate.json', 'meta.json', 'users.json', 'detail.json', 'pg_status.json',
              '.secret', '.power_cache.json', 'validate.json']
SEED_DIRS = ['detail', 'patch', 'gee', 'tiles', 'tiles_dem']   # 实景补丁 + 离线影像/DEM 瓦片金字塔


def bundle_dir():
    """exe 解包目录（源码运行时是项目根目录）。"""
    if getattr(sys, 'frozen', False):
        return getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(sys.executable)))
    return os.path.dirname(os.path.abspath(__file__))


def data_dir():
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    return os.path.join(base, APP_NAME, 'data')


def seed_data():
    """把 exe 内置的数据播种到可写目录；已存在的文件不覆盖（保留用户改动）。
    增加完整性校验：字节数与源不一致的文件重新复制，
    避免 OneDrive 同步中断、杀软拦截等造成的半截文件（如 DEM 字节数为奇数导致 Int16Array 崩溃）。"""
    src = os.path.join(bundle_dir(), 'data')
    dst = data_dir()
    os.makedirs(dst, exist_ok=True)
    copied = 0

    def ok_copy(s, d):
        """复制并校验：源存在且目标缺失或大小不一致时才复制。"""
        if not os.path.exists(s):
            return 0
        need = True
        if os.path.exists(d):
            try:
                need = os.path.getsize(d) != os.path.getsize(s)
            except OSError:
                need = True
        if not need:
            return 0
        shutil.copy2(s, d)
        if os.path.getsize(d) != os.path.getsize(s):
            raise IOError('数据播种不完整：%s' % os.path.basename(s))
        return 1

    for name in SEED_FILES:
        copied += ok_copy(os.path.join(src, name), os.path.join(dst, name))
    for sub in SEED_DIRS:
        sd, dd = os.path.join(src, sub), os.path.join(dst, sub)
        if not os.path.isdir(sd):
            continue
        os.makedirs(dd, exist_ok=True)
        if sub in ('tiles', 'tiles_dem'):
            # 瓦片是 {z}/{x}/{y}.jpg|.png 三级目录，逐层复制
            for root, _dirs, files in os.walk(sd):
                rel = os.path.relpath(root, sd)
                tgt = os.path.join(dd, rel)
                os.makedirs(tgt, exist_ok=True)
                for f in files:
                    if f.endswith(('.jpg', '.png')):
                        copied += ok_copy(os.path.join(root, f), os.path.join(tgt, f))
            continue
        for f in sorted(os.listdir(sd)):
            if not f.endswith(('.jpg', '.bin', '.png')):
                continue
            copied += ok_copy(os.path.join(sd, f), os.path.join(dd, f))
    # 关键数据硬校验：dem256.bin 必须是 131072 字节（256×256×2），否则三维地形必然崩溃
    dem = os.path.join(dst, 'dem256.bin')
    if os.path.exists(dem) and os.path.getsize(dem) != 131072:
        shutil.copy2(os.path.join(src, 'dem256.bin'), dem)
        copied += 1
    return dst, copied


def free_port(start=8080, tries=20):
    for p in range(start, start + tries):
        with socket.socket() as s:
            try:
                s.bind(('0.0.0.0', p))
                return p
            except OSError:
                continue
    return start


def wait_ready(port, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return ips


def main():
    d, copied = seed_data()
    os.environ['JINSHA_DATA'] = d
    port = free_port()
    os.environ['PORT'] = str(port)

    print('=' * 58)
    print('  金沙江流域森林生态环境智能评估系统 · 桌面版')
    print('=' * 58)
    print('  数据目录   %s' % d)
    if copied:
        print('  首次运行   已释放 %d 个数据文件' % copied)
    print('  本机访问   http://127.0.0.1:%d' % port)
    for ip in lan_ips():
        print('  局域网访问 http://%s:%d' % (ip, port))
    print('  账号       why    密码 jinsha2026')
    print('  停止服务   关闭本窗口 或 按 Ctrl+C')
    print('=' * 58 + '\n')

    from server import main as serve
    threading.Thread(target=serve, daemon=True, name='http').start()

    if wait_ready(port):
        if '--no-browser' not in sys.argv:
            webbrowser.open('http://127.0.0.1:%d/login' % port)
    else:
        print('  [警告] 服务启动较慢，请手动打开上面的地址')

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    main()
