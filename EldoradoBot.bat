@echo off
title EldoradoBot
color 0A
cls
cd /d "%~dp0"

echo.
echo  ==========================================
echo    ELDORADO BOT - Iniciando...
echo  ==========================================
echo.

:: ── Node.js ────────────────────────────────────────────────────────────────
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Node.js no encontrado. Instalando...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1"
    echo [OK] Reiniciando...
    start "" cmd /c ""%~f0""
    exit /b 0
)
echo [OK] Node.js listo.

:: ── Dependencias base ──────────────────────────────────────────────────────
if not exist "node_modules\express\package.json" (
    echo [~] Instalando dependencias, espera 1-2 min...
    call npm install --loglevel=error --no-audit 2>nul
    echo [OK] Dependencias instaladas.
)

:: ── Verificar Electron ─────────────────────────────────────────────────────
:CHECK_ELECTRON
set "EBIN=node_modules\electron\dist\electron.exe"
if not exist "%EBIN%" (
    echo [!] Electron no encontrado, instalando version compatible...
    rmdir /s /q "node_modules\electron" >nul 2>&1
    :: Electron 33 es compatible con Node.js v24
    call npm install --save-dev electron@33 --no-audit --loglevel=error 2>nul
    if not exist "%EBIN%" (
        :: Intentar con la ultima version estable
        call npm install --save-dev electron@latest --no-audit --loglevel=error 2>nul
    )
    if not exist "%EBIN%" (
        echo [ERROR] No se pudo instalar Electron.
        echo Asegurate de tener conexion a internet y vuelve a intentar.
        pause & exit /b 1
    )
)
echo [OK] Electron listo.

:: ── Chromium ────────────────────────────────────────────────────────────────
set "FOUND=0"
for /f "delims=" %%f in ('dir /b /s "%LOCALAPPDATA%\ms-playwright\chrome.exe" 2^>nul') do set "FOUND=1"
if "%FOUND%"=="0" (
    echo [~] Descargando Chromium ~150MB...
    call node_modules\.bin\playwright install chromium 2>nul
    if %errorlevel% neq 0 call npx playwright install chromium
)
echo [OK] Chromium listo.

:: ── Abrir bot ──────────────────────────────────────────────────────────────
echo.
echo  Abriendo EldoradoBot...
echo.
call npm start
if %errorlevel% neq 0 ( echo Bot cerrado con error & pause )
