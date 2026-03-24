@echo off
setlocal

cd /d "%~dp0"

if not exist ".env" (
  echo [ERROR] Файл .env не найден.
  echo Сначала создай .env на основе .env.example и добавь OPENAI_API_KEY.
  pause
  exit /b 1
)

start "Transcribator Server" cmd /k "cd /d %~dp0 && set PORT=3100 && npm.cmd start"

timeout /t 2 /nobreak >nul
start "" "http://localhost:3100"

echo Transcribator запускается...
echo Если браузер открылся раньше сервера, просто обнови страницу через пару секунд.
endlocal
