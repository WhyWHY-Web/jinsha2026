@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title 金沙江系统 · 公网访问

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "D:/miniconda3/python.exe" set "PY=D:/miniconda3/python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY (
  echo [错误] 未找到 Python
  pause
  exit /b 1
)

"%PY%" tools\tunnel.py
pause
