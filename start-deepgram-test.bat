@echo off
setlocal

cd /d "%~dp0"

if not exist ".env" (
  echo [ERROR] Файл .env не найден.
  echo Сначала создай .env на основе .env.example и добавь OPENAI_API_KEY и DEEPGRAM_API_KEY.
  pause
  exit /b 1
)

start "Transcribator Deepgram Test" cmd /k "cd /d %~dp0 && set PORT=3001 && set TRANSCRIBE_PROVIDER=deepgram && npm.cmd start"

timeout /t 2 /nobreak >nul
start "" "http://localhost:3001"

echo Deepgram test mode запускается на http://localhost:3001
echo Основную ветку можно держать параллельно на http://localhost:3000
endlocal
