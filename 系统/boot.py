"""Run the local server and open the desktop dashboard once it is ready."""
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlencode
from urllib.request import ProxyHandler, build_opener
import webbrowser


def _data_directory():
    override = os.environ.get('JINSHA_DATA')
    if override:
        return Path(override).expanduser().resolve()

    if getattr(sys, 'frozen', False):
        sibling = Path(sys.executable).resolve().parent / 'data'
        if (sibling / 'meta.json').is_file() and (sibling / 'dem.bin').is_file():
            return sibling
        return Path(sys._MEIPASS) / 'data'

    return Path(__file__).resolve().parent / 'data'


def _open_dashboard(port, create_token):
    base = f'http://127.0.0.1:{port}'
    opener = build_opener(ProxyHandler({}))
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with opener.open(f'{base}/api/health', timeout=1) as response:
                if response.status == 200:
                    token = create_token()
                    url = f'{base}/auto?{urlencode({"t": token})}' if token else f'{base}/'
                    webbrowser.open(url)
                    return
        except OSError:
            pass
        time.sleep(0.25)
    print(f'[启动器] 浏览器启动等待超时，可手动打开 {base}/', flush=True)


def main():
    data = _data_directory()
    os.environ['JINSHA_DATA'] = str(data)
    os.environ.setdefault('JINSHA_HOST', '127.0.0.1')
    if getattr(sys, 'frozen', False):
        local = Path(os.environ.get('LOCALAPPDATA') or Path.home() / 'AppData' / 'Local')
        os.environ.setdefault('JINSHA_STATE', str(local / 'JinshaEco'))
    print(f'[启动器] 数据目录：{data}', flush=True)

    no_browser = '--no-browser' in sys.argv
    if no_browser:
        sys.argv.remove('--no-browser')

    import server

    def on_ready(port):
        if no_browser:
            return
        threading.Thread(target=_open_dashboard, args=(port, server.auto_login_token), daemon=True).start()

    server.main(ready=on_ready)


if __name__ == '__main__':
    main()
