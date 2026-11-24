@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 金沙江流域森林生态环境智能评估系统

where python >nul 2>nul
if %errorlevel%==0 (
  set PY=python
) else (
  if exist "D:\miniconda3\python.exe" (set PY=D:\miniconda3\python.exe) else (
    echo 未找到 Python，请先安装 Python 3.9+ 并勾选 Add to PATH
    pause & exit /b
  )
)

echo 正在启动服务...
start "" http://127.0.0.1:8080
%PY% server.py --port 8080
pause
