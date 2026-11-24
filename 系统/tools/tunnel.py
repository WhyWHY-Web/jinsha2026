# -*- coding: utf-8 -*-
"""
一键开启公网访问（Cloudflare 临时隧道，无需注册）
  · 自动检测/启动本地服务（8080）
  · 启动 cloudflared 并解析公网地址
  · 地址写入 data/public_url.txt，窗口内持续显示
停止：在本窗口按 Ctrl + C
"""
import os
import re
import socket
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXE = os.path.join(ROOT, 'tools', 'bin', 'cloudflared.exe')
LOG = os.path.join(ROOT, 'tools', 'bin', 'tunnel.log')
URLFILE = os.path.join(ROOT, 'data', 'public_url.txt')
PORT = int(os.environ.get('PORT', 8080))

BANNER = '=' * 62


def port_open(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def ensure_server():
    if port_open(PORT):
        print('  本地服务已在运行：http://127.0.0.1:%d' % PORT)
        return None
    py = sys.executable
    print('  正在启动本地服务…')
    p = subprocess.Popen([py, os.path.join(ROOT, 'server.py'), '--port', str(PORT)],
                         cwd=ROOT, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    for _ in range(30):
        time.sleep(0.5)
        if port_open(PORT):
            print('  本地服务已就绪')
            return p
    print('  [错误] 本地服务启动超时')
    sys.exit(1)


def main():
    print(BANNER)
    print('  金沙江系统 · 公网访问')
    print(BANNER)
    if not os.path.exists(EXE):
        print('  未找到 cloudflared：tools/bin/cloudflared.exe')
        print('  请重新下载或联系维护者')
        input('  按回车退出…')
        return

    srv = ensure_server()
    if os.path.exists(LOG):
        try:
            os.remove(LOG)
        except OSError:
            pass

    print('  正在建立公网隧道（约 5–15 秒）…\n')
    proc = subprocess.Popen(
        [EXE, 'tunnel', '--url', 'http://127.0.0.1:%d' % PORT, '--no-autoupdate',
         '--logfile', LOG, '--loglevel', 'info'],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    url = None
    for _ in range(60):
        time.sleep(1)
        if os.path.exists(LOG):
            try:
                txt = open(LOG, encoding='utf-8', errors='ignore').read()
            except OSError:
                continue
            m = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', txt)
            if m:
                url = m.group(0)
                break
        if proc.poll() is not None:
            break

    if not url:
        print('  [错误] 隧道建立失败，请检查网络后重试')
        proc.terminate()
        input('  按回车退出…')
        return

    try:
        os.makedirs(os.path.dirname(URLFILE), exist_ok=True)
        with open(URLFILE, 'w', encoding='utf-8') as f:
            f.write(url + '\n')
    except OSError:
        pass

    # 等待域名生效（首次通常 5–20 秒）
    print('  等待公网域名生效…')
    import urllib.request
    ok = False
    for _ in range(20):
        try:
            with urllib.request.urlopen(url + '/login', timeout=8) as r:
                if r.status == 200:
                    ok = True
                    break
        except Exception:
            time.sleep(1.5)

    print(BANNER)
    print('  公网地址：' + url)
    print('  账号：why    密码：jinsha2026')
    print(BANNER)
    if not ok:
        print('  （域名可能还需十几秒生效，打不开就稍等再刷新）')
    print('  把这个地址发给别人，任何网络都能打开（需登录）。')
    print('  注意：临时地址每次重启都会变；本窗口关闭后地址失效。')
    print('  按 Ctrl + C 停止公网访问（本地服务不受影响）。\n')

    try:
        proc.wait()
    except KeyboardInterrupt:
        print('\n  正在关闭隧道…')
        proc.terminate()
        time.sleep(1)
        if srv:
            srv.terminate()
        print('  已停止')


if __name__ == '__main__':
    main()
