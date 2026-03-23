# Transcribator

Веб-приложение для транскрибации видео и аудио с таймкодами и структурированным саммари рабочих встреч.

## Что умеет

- принимает аудио и видеофайлы через браузер;
- поддерживает drag-and-drop без открытия файла в соседней вкладке;
- автоматически извлекает аудио из видео;
- сжимает аудио перед отправкой в ASR;
- режет большой подготовленный аудиофайл на чанки;
- собирает полный транскрипт с таймкодами;
- делает TL;DR и структурированное саммари встречи;
- выделяет цель созвона, решения, договоренности, открытые вопросы и action items;
- позволяет переключать тему интерфейса между `STILT` и `NEON`.

## Технологии

- Node.js
- Express
- Multer
- OpenAI Node SDK
- ffmpeg-static
- ffprobe-static

## Провайдеры транскрибации

Приложение умеет работать с двумя ASR-провайдерами:

- `openai` - текущий базовый путь через `OPENAI_API_KEY`
- `deepgram` - отдельная ветка интеграции через `DEEPGRAM_API_KEY`

Важно:

- саммари встречи по-прежнему строится через OpenAI Responses API;
- даже при `TRANSCRIBE_PROVIDER=deepgram` ключ `OPENAI_API_KEY` все равно нужен для summary-блока.

## Быстрый старт

1. Установи зависимости:

```powershell
npm.cmd install
```

2. Создай `.env` на основе шаблона:

```powershell
Copy-Item .env.example .env
```

3. Заполни ключи и выбери провайдера:

```env
OPENAI_API_KEY=your_openai_api_key_here
DEEPGRAM_API_KEY=your_deepgram_api_key_here
TRANSCRIBE_PROVIDER=openai
```

Для теста Deepgram поменяй:

```env
TRANSCRIBE_PROVIDER=deepgram
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=ru
```

4. Запусти приложение:

```powershell
npm.cmd start
```

5. Открой [http://localhost:3000](http://localhost:3000)

Или просто запусти [start-app.bat](C:/Users/Askay/Desktop/AI/transcribator/start-app.bat) двойным кликом.

## Переменные окружения

- `OPENAI_API_KEY` - обязателен для summary
- `DEEPGRAM_API_KEY` - обязателен для Deepgram-транскрибации
- `PORT` - порт сервера, по умолчанию `3000`
- `TRANSCRIBE_PROVIDER` - `openai` или `deepgram`
- `TRANSCRIPTION_MODEL` - модель OpenAI, по умолчанию `whisper-1`
- `DEEPGRAM_MODEL` - модель Deepgram, по умолчанию `nova-3`
- `DEEPGRAM_LANGUAGE` - язык транскрибации, по умолчанию `ru`
- `DEEPGRAM_PUNCTUATE` - включить пунктуацию, по умолчанию `true`
- `DEEPGRAM_DIARIZE` - просить speaker diarization, по умолчанию `true`
- `DEEPGRAM_UTTERANCES` - просить разбивку на utterances, по умолчанию `true`
- `DEEPGRAM_SMART_FORMAT` - включить smart formatting, по умолчанию `true`
- `SUMMARY_MODEL` - модель для summary, по умолчанию `gpt-4o-mini`
- `MAX_UPLOAD_MB` - лимит файла для самого сервера, по умолчанию `512`
- `AUDIO_BITRATE` - битрейт подготовленного аудио, по умолчанию `48k`
- `AUDIO_SAMPLE_RATE` - sample rate подготовленного аудио, по умолчанию `16000`

## Как устроен Deepgram-режим

- preprocessing через `ffmpeg` остается тем же;
- подготовленный файл отправляется в `Deepgram /v1/listen`;
- ответ нормализуется в тот же внутренний формат сегментов, что и OpenAI;
- summary и итоговые блоки продолжают строиться поверх единого нормализованного транскрипта.

Это позволяет безопасно сравнивать провайдеров без переписывания фронтенда.

## Как откатиться обратно на OpenAI

Просто поменяй в `.env`:

```env
TRANSCRIBE_PROVIDER=openai
```

И перезапусти приложение.

## Ограничения

- Deepgram-интеграция в этой ветке работает как batch transcription для подготовленного аудио;
- summary по-прежнему зависит от OpenAI;
- качество таймкодов и сегментации зависит от исходной записи и качества ASR-ответа провайдера.
