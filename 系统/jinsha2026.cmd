@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title 金沙江流域生态智能评估系统

set "PORT=8080"
set "URL=http://127.0.0.1:%PORT%"

set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY if exist "D:/miniconda3/python.exe" set "PY=D:/miniconda3/python.exe"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python313\python.exe" set "PY=%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not defined PY (
  echo [错误] 未找到 Python，请安装 Python 3.9+ 并勾选 Add to PATH
  pause
  exit /b 1
)

netstat -an | findstr /C:":%PORT% " | findstr /C:"LISTENING" >nul 2>nul
if not errorlevel 1 goto OPEN

echo 正在启动金沙江系统服务...
start "金沙江服务" /min "%PY%" server.py --port %PORT%

set /a N=0
:WAIT
set /a N+=1
timeout /t 1 >nul
netstat -an | findstr /C:":%PORT% " | findstr /C:"LISTENING" >nul 2>nul
if not errorlevel 1 goto OPEN
if %N% GEQ 25 (
  echo [错误] 服务启动超时，请查看“金沙江服务”窗口
  pause
  exit /b 1
)
goto WAIT

:OPEN
echo 正在用 Chrome 打开界面...
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "%URL%"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" "%URL%"
) else if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
  start "" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" "%URL%"
) else (
  echo 未检测到 Chrome，改用系统默认浏览器
  start "" "%URL%"
)

echo.
echo   界面地址：%URL%
echo   账号：why    密码：jinsha2026
echo   关闭服务：关闭标题为“金沙江服务”的窗口即可
echo.
timeout /t 5 >nul
endlocal
