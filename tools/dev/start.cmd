@echo off
setlocal

REM This script lives in tools\dev; ROOT is the repository root (with a trailing backslash).
for %%I in ("%~dp0..\..") do set "ROOT=%%~fI\"

REM Explorer access on this Windows setup requires MossStudio's elevated token.
powershell -NoProfile -Command "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $principal = [Security.Principal.WindowsPrincipal]::new($identity); if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  set "MOSSSTUDIO_START_SCRIPT=%~f0"
  set "MOSSSTUDIO_START_DIR=%~dp0"
  powershell -NoProfile -Command "$arguments = @('/c', ('""' + $env:MOSSSTUDIO_START_SCRIPT + '""')); Start-Process -FilePath $env:ComSpec -ArgumentList $arguments -WorkingDirectory $env:MOSSSTUDIO_START_DIR -Verb RunAs"
  if errorlevel 1 (
    echo MossStudio needs administrator permission to open Windows Explorer.
    pause
    exit /b 1
  )
  exit /b 0
)

set "APP=%ROOT%apps\desktop"
set "EXE=%APP%\node_modules\electron\dist\electron.exe"
set "LOG=%ROOT%.tools\start.log"

if not exist "%ROOT%.tools" mkdir "%ROOT%.tools"

if not exist "%EXE%" goto missing_runtime
if not exist "%APP%\out\main\index.js" goto missing_build
if not exist "%APP%\out\main\backend.js" goto missing_build
if not exist "%APP%\out\preload\index.js" goto missing_build
if not exist "%APP%\out\renderer\index.html" goto missing_build

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_RENDERER_URL="

echo [%date% %time%] starting MossStudio > "%LOG%"
echo log: %LOG%

REM --no-sandbox is required on machines where Chromium's sandbox cannot start
REM (restricted account, hardened policy). Drop it once the packaged build ships
REM with a signed installer.
"%EXE%" "%APP%" --no-sandbox >> "%LOG%" 2>&1

set "CODE=%errorlevel%"
echo.
if not "%CODE%"=="0" (
  echo MossStudio exited with code %CODE%.
  echo Last lines of %LOG%:
  echo ---------------------------------------------
  powershell -NoProfile -Command "Get-Content -Tail 20 '%LOG%'" 2>nul
  echo ---------------------------------------------
  pause
)
exit /b %CODE%

:missing_runtime
echo Electron runtime is missing. Run these commands from the repository root:
echo   corepack pnpm install --frozen-lockfile
echo   corepack pnpm --filter @clover/desktop exec electron --version
pause
exit /b 1

:missing_build
echo Desktop build is missing. Run this command from the repository root:
echo   corepack pnpm --filter @clover/desktop build
pause
exit /b 1
