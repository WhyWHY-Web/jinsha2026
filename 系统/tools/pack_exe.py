# -*- coding: utf-8 -*-
"""
一键打包单文件 exe（dist\JinshaEco.exe）。

用法
  python tools/pack_exe.py

做的事
  1. 把 data/ 里需要的东西（含 detail/ 实景补丁）暂存到 %TEMP%\\jp\\data
  2. 调 PyInstaller 打成 onefile 单 exe
  3. 拷贝到项目 dist/ 目录

注意
  - 依赖 PyInstaller：pip install pyinstaller
  - 可写数据（账号、审计、新增站点）在运行时释放到 %LOCALAPPDATA%\\JinshaEco\\data，
    所以 exe 里只放"出厂数据"，用户的改动不会被覆盖
  - .power_cache.json（STAC/DEM 原始响应缓存）和 audit.log 不打进 exe
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(os.path.dirname(sys.executable), 'pyinstaller.exe')
if not os.path.exists(PY):
    # venv 里可能只有 Scripts/pyinstaller.exe（没有 python.exe），它自带解释器，可直接调用
    for p in [r'C:\Users\19682\.workbuddy-ai\binaries\python\envs\default\Scripts\pyinstaller.exe',
              os.path.join(sys.prefix, 'Scripts', 'pyinstaller.exe')]:
        if os.path.exists(p):
            PY = p
            break
    else:
        sys.exit('找不到 pyinstaller.exe，请先 pip install pyinstaller')

STAGE = os.path.join(tempfile.gettempdir(), 'jp')
DATA = os.path.join(STAGE, 'data')
DIST = os.path.join(STAGE, 'dist')

FILES = ['dem.bin', 'dem256.bin', 'dem512.bin', 'streams.json', 'hydro.json', 'stations.json',
         'climate.json', 'meta.json', 'users.json', 'detail.json', 'pg_status.json', 'validate.json']

os.makedirs(os.path.join(DATA, 'detail'), exist_ok=True)
missing = [f for f in FILES if not os.path.exists(os.path.join(ROOT, 'data', f))]
if missing:
    print('提示：data/ 下缺 %s，跳过（不影响打包）' % '、'.join(missing))
FILES = [f for f in FILES if f not in missing]
for f in FILES:
    shutil.copy2(os.path.join(ROOT, 'data', f), os.path.join(DATA, f))
src = os.path.join(ROOT, 'data', 'detail')
for f in sorted(os.listdir(src)):
    if f.endswith(('.bin', '.jpg')):
        shutil.copy2(os.path.join(src, f), os.path.join(DATA, 'detail', f))
# GEE 遥感时序缓存（8 个指标的站×月数值，约 2 MB）
gee_dir = os.path.join(ROOT, 'data', 'gee')
if os.path.isdir(gee_dir):
    os.makedirs(os.path.join(DATA, 'gee'), exist_ok=True)
    for f in sorted(os.listdir(gee_dir)):
        if f.endswith('.json'):
            shutil.copy2(os.path.join(gee_dir, f), os.path.join(DATA, 'gee', f))
# 离线影像瓦片金字塔：z10–14，2.2 万张，离线也能放大到清晰。
# 注意：本地已有 4096² 全域高清影像（satellite-3d-hd.jpg），瓦片只是放大时的补充；
# 默认不打进 exe 以控制体积（258 MB），需要离线高清时设环境变量 PACK_TILES=1。
tiles_dir = os.path.join(ROOT, 'data', 'tiles')
if os.path.isdir(tiles_dir) and os.environ.get('PACK_TILES') == '1':
    for root, _dirs, files in os.walk(tiles_dir):
        rel = os.path.relpath(root, tiles_dir)
        tgt = os.path.join(DATA, 'tiles', rel)
        os.makedirs(tgt, exist_ok=True)
        for f in files:
            if f.endswith('.jpg'):
                shutil.copy2(os.path.join(root, f), os.path.join(tgt, f))
else:
    print('跳过离线瓦片（设 PACK_TILES=1 可打进去，约 258 MB）')
# 实景补丁的视野块缓存（离线也能看已缓存区域的实景）
os.makedirs(os.path.join(DATA, 'patch'), exist_ok=True)
patch_dir = os.path.join(ROOT, 'data', 'patch')
if os.path.isdir(patch_dir):
    for f in sorted(os.listdir(patch_dir)):
        if f.endswith(('.bin', '.jpg')):
            shutil.copy2(os.path.join(patch_dir, f), os.path.join(DATA, 'patch', f))
# 其余 datasets：basin / scenarios / governance / ml_models 等 JSON（体积很小，统一带上）
for f in sorted(os.listdir(os.path.join(ROOT, 'data'))):
    if f.endswith('.json') and f not in FILES:
        shutil.copy2(os.path.join(ROOT, 'data', f), os.path.join(DATA, f))
# DEM 瓦片金字塔（tiles_dem：z10 PNG）——当前前端从 dem.bin 直接构建地形，
# 不走这目录；保留打包开关以免以后接入时需要。
tdir = os.path.join(ROOT, 'data', 'tiles_dem')
if os.path.isdir(tdir) and os.environ.get('PACK_TILES') == '1':
    for root, _dirs, files in os.walk(tdir):
        rel = os.path.relpath(root, tdir)
        tgt = os.path.join(DATA, 'tiles_dem', rel)
        os.makedirs(tgt, exist_ok=True)
        for f in files:
            if f.endswith('.png'):
                shutil.copy2(os.path.join(root, f), os.path.join(tgt, f))
total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(DATA) for f in fs)
print('暂存数据 %.1f MB（%d 个文件）' % (total / 1048576, len(FILES) + len(os.listdir(os.path.join(DATA, 'detail')))))

cmd = [PY, '--noconfirm', '--onefile', '--console', '--name', 'JinshaEco',
       '--distpath', DIST, '--workpath', os.path.join(STAGE, 'build'),
       '--specpath', STAGE]
ICON = os.path.join(ROOT, 'tools', 'app.ico')
if os.path.exists(ICON):
    cmd += ['--icon', ICON]          # 图标由 tools/make_icon.py 生成
else:
    print('提示：未找到 tools/app.ico，使用默认图标（可先跑 python tools/make_icon.py）')
cmd += ['--add-data', os.path.join(ROOT, 'web') + ';web',
        '--add-data', DATA + ';data',
        os.path.join(ROOT, 'launcher.py')]
print('打包中…')
subprocess.run(cmd, cwd=ROOT, check=True)

out = os.path.join(ROOT, 'dist')
os.makedirs(out, exist_ok=True)
dst = os.path.join(out, 'JinshaEco.exe')
shutil.copy2(os.path.join(DIST, 'JinshaEco.exe'), dst)
print('完成 → %s（%.1f MB）' % (dst, os.path.getsize(dst) / 1048576))
