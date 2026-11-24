# -*- coding: utf-8 -*-
"""
云端/命令行统一入口。
平台默认执行 `python main.py`，这里转发到 server.py 的 main()。
端口由环境变量 PORT 决定（本地缺省 8080），绑定 0.0.0.0。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from server import main

if __name__ == '__main__':
    main()
