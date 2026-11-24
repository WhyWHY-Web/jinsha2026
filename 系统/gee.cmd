@echo off
cd /d "%~dp0"
set "PY=C:\Users\19682\.workbuddy\binaries\python\versions\3.13.12\python.exe"
if not exist "%PY%" set "PY=D:\miniconda3\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0tools\gee_sync.py" %*
