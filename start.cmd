@echo off
setlocal

set "APP=%~dp0apps\desktop"
set "EXE=%APP%\node_modules\electron\dist\electron.exe"
set "LOG=%~dp0.tools\start.log"

if not exist "%~dp0.tools" mkdir "%~dp0.tools"

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
