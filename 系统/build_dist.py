# -*- coding: utf-8 -*-
"""
构建「可直接发给别人电脑」的单文件 exe：
- 内置 web/ 前端 + data/ 关键数据（3D 地形 dem.bin、河流、图表 JSON、实景块 detail/patch）
- 排除只在 2D 底图用到的 tiles(246MB)、未被前端引用的 rsei/*.tif(50MB) 与 tiles_dem(38.5MB)、sql 快照
用法：python build_dist.py
"""
import os
import shutil
import subprocess
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, 'data')
STAGE = os.path.join(BASE, '_dist_data')
EXCLUDE_DIRS = {'tiles', 'tiles_dem', 'sql'}
EXCLUDE_EXT = {'.tif', '.log'}
EXCLUDE_FILES = {'.power_cache.json', '.secret'}


def build_stage():
    # 已有暂存数据则直接复用（数据未变），避免触发批量删除安全策略
    if os.path.isdir(STAGE) and os.listdir(STAGE):
        total = 0
        for r, d, fs in os.walk(STAGE):
            for f in fs:
                try:
                    total += os.path.getsize(os.path.join(r, f))
                except OSError:
                    pass
        print('[stage] 复用已有 _dist_data (%.1f MB)；如需重建请手动删除该目录' % (total / 1024 / 1024))
        return total
    os.makedirs(STAGE, exist_ok=True)
    n = 0
    total = 0
    for root, dirs, files in os.walk(DATA):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        rel = os.path.relpath(root, DATA)
        dst_dir = STAGE if rel == '.' else os.path.join(STAGE, rel)
        os.makedirs(dst_dir, exist_ok=True)
        for f in files:
            if f in EXCLUDE_FILES or os.path.splitext(f)[1].lower() in EXCLUDE_EXT:
                continue
            src = os.path.join(root, f)
            shutil.copy2(src, os.path.join(dst_dir, f))
            n += 1
            try:
                total += os.path.getsize(src)
            except OSError:
                pass
    print('[stage] 复制 %d 个文件, %.1f MB -> %s' % (n, total / 1024 / 1024, STAGE))
    return total


def main():
    build_stage()
    print('[build] 开始 PyInstaller 打包（含数据，耗时较长）…')
    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--onefile', '--name', '金沙江生态评估',
        '--add-data', 'web;web',
        '--add-data', '_dist_data;data',
        '--hidden-import', 'features',
        '--exclude-module', 'numpy', '--exclude-module', 'PIL', '--exclude-module', 'Pillow',
        '--distpath', os.path.join(BASE, '_dist'), '--workpath', os.path.join(BASE, '_pybuild'),
        '--specpath', BASE, '--noconfirm',
        os.path.join(BASE, 'boot.py'),
    ]
    r = subprocess.run(cmd, cwd=BASE)
    if r.returncode != 0:
        print('[build] 失败'); return
    out = os.path.join(BASE, '_dist', '金沙江生态评估.exe')
    print('[build] 完成: %s  %.1f MB' % (out, os.path.getsize(out) / 1024 / 1024))


if __name__ == '__main__':
    main()
