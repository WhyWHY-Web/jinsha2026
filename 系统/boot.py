# -*- coding: utf-8 -*-
"""
打包启动器（双击 exe 的入口）。

职责：
1. 定位外部数据目录 data/（用 JINSHA_DATA 注入，server.py 已支持）
2. 启动后端服务（server.py，纯标准库 ThreadingHTTPServer）
3. 服务起来后自动免密登录并打开浏览器 → 三维数字孪生主界面（/）
   （数据看板 /dashboard 仍可通过主界面右上角「数据看板」入口访问）

设计说明：
- data/ 目录（含地图瓦片/遥感图/分析 JSON，约 500MB）外置、与 exe 同目录，
  不打包进 exe，便于数据更新与体积控制。
- 不依赖项目内其他启动脚本，独立可运行。
"""
import os
import sys
import threading
import time
import webbrowser


def _base_dir():
    """exe / 脚本所在目录。"""
    if getattr(sys, 'frozen', False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _resolve_data_dir(base):
    """优先找外部 data 目录；找不到返回 None（交给 server 用默认值）。"""
    cands = [
        os.environ.get('JINSHA_DATA'),
        os.path.join(base, 'data'),
        os.path.join(base, '系统', 'data'),
        os.path.join(base, '..', 'data'),
    ]
    for c in cands:
        if c and os.path.isdir(c):
            return c
    return None


def _parse_port():
    if '--port' in sys.argv:
        return int(sys.argv[sys.argv.index('--port') + 1])
    if os.environ.get('PORT'):
        return int(os.environ['PORT'])
    return 8080


def main():
    base = _base_dir()
    data_dir = _resolve_data_dir(base)
    if data_dir:
        os.environ['JINSHA_DATA'] = data_dir
        print('[启动器] 数据目录：%s' % data_dir)
    else:
        print('[启动器] 未找到 data/ 目录，将使用空数据目录（部分功能不可用）。')

    port = _parse_port()
    os.environ['PORT'] = str(port)

    # 先确保账号文件存在，再生成一次性免密登录令牌
    import server
    server.init_users()
    auto_tok = server.auto_login_token()

    # 服务启动后自动打开浏览器 → 免密登录 → 三维主界面
    def _open():
        time.sleep(2.0)
        url = ('http://127.0.0.1:%d/auto?t=%s' % (port, auto_tok)) if auto_tok \
            else 'http://127.0.0.1:%d/' % port
        webbrowser.open(url)
    threading.Thread(target=_open, daemon=True).start()

    # 运行后端
    try:
        server.main()
    except OSError as e:
        print('\n[启动失败] %s' % e)
        print('请确认端口 %d 未被占用（如已运行本系统请先关闭），再重新双击。' % port)
        input('\n按回车键退出...')


if __name__ == '__main__':
    main()
