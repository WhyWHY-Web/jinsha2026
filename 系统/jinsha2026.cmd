@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PY="
where python.exe >nul 2>nul && set "PY=python.exe"
if not defined PY if exist "D:\miniconda3\python.exe" set "PY=D:\miniconda3\python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY (
  echo Python 3.10 or newer is required to launch from source.
  pause
  exit /b 1
)

"%PY%" boot.py %*
if errorlevel 1 pause
