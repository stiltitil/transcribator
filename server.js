const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const dotenv = require("dotenv");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const rawFfmpegPath = require("ffmpeg-static");
const rawFfprobe = require("ffprobe-static");

dotenv.config({
  path: resolveEnvPath(),
});

applySettingsToEnv(loadPersistedSettings());

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = process.env.TRANSCRIBATOR_UPLOAD_DIR || path.join(__dirname, "uploads");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
const maxApiFileBytes = 24 * 1024 * 1024;
const preparedAudioBitrate = process.env.AUDIO_BITRATE || "48k";
const preparedAudioSampleRate = process.env.AUDIO_SAMPLE_RATE || "16000";
const ffmpegPath = resolveBundledBinaryPath(rawFfmpegPath);
const ffprobePath = resolveBundledBinaryPath(rawFfprobe?.path);

const supportedMimeTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/octet-stream",
]);

const supportedExtensions = new Set([
  ".mp3",
  ".mp4",
  ".mpeg",
  ".mpga",
  ".m4a",
  ".wav",
  ".webm",
  ".mov",
]);

if (!process.env.DEEPGRAM_API_KEY) {
  console.warn("DEEPGRAM_API_KEY is missing. Transcription routes will fail until it is set.");
}

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is missing. Summary generation will fail until it is set.");
}

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeBase = path
      .parse(file.originalname)
      .name.replace(/[^a-zA-Z0-9-_]/g, "-")
      .slice(0, 80);
    const ext = path.extname(file.originalname) || ".bin";
    cb(null, `${Date.now()}-${safeBase || "upload"}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeOk = supportedMimeTypes.has(file.mimetype);
    const extOk = supportedExtensions.has(ext);

    if (mimeOk || extOk) {
      cb(null, true);
      return;
    }

    cb(
      new Error(
        "Unsupported file type. Use mp3, mp4, mpeg, mpga, m4a, wav, webm, or mov."
      )
    );
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasTranscriptionKey: Boolean(process.env.DEEPGRAM_API_KEY),
    hasSummaryKey: Boolean(process.env.OPENAI_API_KEY),
    transcriptionModel: getDeepgramModel(),
    summaryModel: getSummaryModel(),
  });
});

app.get("/api/settings", (_req, res) => {
  res.json({
    hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
    hasDeepgramKey: Boolean(process.env.DEEPGRAM_API_KEY),
    openAiApiKey: process.env.OPENAI_API_KEY || "",
    deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",
    openAiKeyPreview: maskSecret(process.env.OPENAI_API_KEY),
    deepgramKeyPreview: maskSecret(process.env.DEEPGRAM_API_KEY),
    deepgramModel: getDeepgramModel(),
    deepgramLanguage: getDeepgramLanguage(),
    summaryModel: getSummaryModel(),
  });
});

app.post("/api/settings", async (req, res) => {
  try {
    const existing = loadPersistedSettings();
    const next = {
      ...existing,
      ...sanitizeSettingsPayload(req.body || {}),
    };

    persistSettings(next);
    applySettingsToEnv(next);

    res.json({
      ok: true,
      hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY),
      hasDeepgramKey: Boolean(process.env.DEEPGRAM_API_KEY),
      openAiApiKey: process.env.OPENAI_API_KEY || "",
      deepgramApiKey: process.env.DEEPGRAM_API_KEY || "",
      openAiKeyPreview: maskSecret(process.env.OPENAI_API_KEY),
      deepgramKeyPreview: maskSecret(process.env.DEEPGRAM_API_KEY),
      deepgramModel: getDeepgramModel(),
      deepgramLanguage: getDeepgramLanguage(),
      summaryModel: getSummaryModel(),
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Failed to save settings.",
    });
  }
});

app.post("/api/settings/check", async (_req, res) => {
  try {
    const [deepgram, openai] = await Promise.all([
      checkDeepgramCredentials(),
      checkOpenAiCredentials(),
    ]);

    res.json({
      ok: true,
      deepgram,
      openai,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message || "Failed to check credentials.",
    });
  }
});

app.post("/api/transcribe", upload.single("media"), async (req, res) => {
  let cleanupPaths = [];
  const includeSummary = shouldIncludeSummary(req.body?.includeSummary);

  if (!process.env.DEEPGRAM_API_KEY) {
    res.status(500).json({
      error: "DEEPGRAM_API_KEY is not configured.",
    });
    return;
  }

  if (includeSummary && !process.env.OPENAI_API_KEY) {
    res.status(500).json({
      error: "OPENAI_API_KEY is not configured.",
    });
    return;
  }

  if (!req.file) {
    res.status(400).json({
      error: "No file uploaded.",
    });
    return;
  }

  try {
    const prepared = await prepareMediaForTranscription(req.file);
    cleanupPaths = prepared.cleanupPaths;

    const transcript = await transcribePreparedChunks(prepared.chunks);
    const normalized = normalizeTranscript(transcript);
    const summary = includeSummary
      ? await summarizeTranscript(normalized)
      : emptySummary(normalized.segments);

    res.json({
      fileName: req.file.originalname,
      transcript: normalized.text,
      overview: summary.overview,
      summary: summary.summary,
      tldr: summary.tldr,
      meetingGoal: summary.meetingGoal,
      highlights: summary.highlights,
      keyDecisions: summary.keyDecisions,
      agreements: summary.agreements,
      openQuestions: summary.openQuestions,
      actionItems: summary.actionItems,
      chapters: summary.chapters,
      segments: normalized.segments,
      metadata: {
        detectedLanguage: transcript.language || "unknown",
        durationSeconds: normalized.durationSeconds,
        sourceSizeMb: toMb(req.file.size),
        preparedAudioSizeMb: toMb(prepared.audioSizeBytes),
        chunkCount: prepared.chunks.length,
        preprocessing: prepared.mode,
        transcriptionModel: getDeepgramModel(),
        summaryEnabled: includeSummary,
        summaryModel: includeSummary ? getSummaryModel() : null,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error.message || "Something went wrong during transcription.",
    });
  } finally {
    await cleanupRequestArtifacts([req.file.path, ...cleanupPaths]);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({
      error: `Uploaded file is too large for this server. Current limit: ${Math.round(
        maxUploadBytes / 1024 / 1024
      )} MB.`,
    });
    return;
  }

  res.status(400).json({
    error: error.message || "Bad request.",
  });
});

let activeServer = null;

function startServer(customPort = port) {
  if (activeServer) {
    return activeServer;
  }

  activeServer = app.listen(customPort, () => {
    console.log(`Transcribator is running on http://localhost:${customPort}`);
  });

  return activeServer;
}

async function transcribeFile(filePath) {
  const query = new URLSearchParams({
    model: getDeepgramModel(),
    language: getDeepgramLanguage(),
    punctuate: "true",
    diarize: "true",
    utterances: "true",
    smart_format: "true",
  });

  const response = await fetch(`https://api.deepgram.com/v1/listen?${query.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      "Content-Type": "audio/mpeg",
    },
    body: await fsp.readFile(filePath),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.err_msg || payload?.message || payload?.error || "Deepgram transcription failed."
    );
  }

  return normalizeDeepgramTranscript(payload);
}

async function transcribePreparedChunks(chunks) {
  const combined = {
    text: "",
    language: "unknown",
    segments: [],
  };

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const transcript = await transcribeFile(chunk.path);
    const text = (transcript.text || "").trim();
    const segments = Array.isArray(transcript.segments) ? transcript.segments : [];

    if (index === 0 && transcript.language) {
      combined.language = transcript.language;
    }

    combined.text = [combined.text, text].filter(Boolean).join("\n").trim();
    combined.segments.push(
      ...segments.map((segment, segmentIndex) => ({
        ...segment,
        id: combined.segments.length + segmentIndex,
        start: Number(segment.start || 0) + chunk.offsetSeconds,
        end: Number(segment.end || 0) + chunk.offsetSeconds,
      }))
    );
  }

  return combined;
}

function normalizeDeepgramTranscript(payload) {
  const results = payload?.results || {};
  const alternative = results?.channels?.[0]?.alternatives?.[0] || {};
  const utterances = Array.isArray(results.utterances) ? results.utterances : [];

  const segments = utterances.length
    ? utterances
        .map((utterance, index) => ({
          id: utterance.id ?? index,
          start: Number(utterance.start || 0),
          end: Number(utterance.end || 0),
          text: String(utterance.transcript || "").trim(),
        }))
        .filter((segment) => segment.text)
    : buildDeepgramWordSegments(alternative.words);

  return {
    text:
      String(alternative.transcript || "").trim() ||
      segments.map((segment) => segment.text).join("\n").trim(),
    language: results?.languages?.[0] || getDeepgramLanguage() || "unknown",
    segments,
  };
}

function buildDeepgramWordSegments(words) {
  if (!Array.isArray(words) || words.length === 0) {
    return [];
  }

  const segments = [];
  let current = null;

  for (const word of words) {
    const token = String(word?.punctuated_word || word?.word || "").trim();

    if (!token) {
      continue;
    }

    const speaker =
      typeof word?.speaker === "number" || typeof word?.speaker === "string"
        ? word.speaker
        : "unknown";

    if (!current || current.speaker !== speaker) {
      current = {
        id: segments.length,
        start: Number(word.start || 0),
        end: Number(word.end || 0),
        speaker,
        parts: [token],
      };
      segments.push(current);
      continue;
    }

    current.end = Number(word.end || current.end || 0);
    current.parts.push(token);
  }

  return segments
    .map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      text: segment.parts.join(" ").trim(),
    }))
    .filter((segment) => segment.text);
}

async function prepareMediaForTranscription(file) {
  const preparedAudioPath = path.join(
    uploadDir,
    `${path.parse(file.filename).name}-prepared.mp3`
  );

  await transcodeToSpeechAudio(file.path, preparedAudioPath);

  const preparedStat = await fsp.stat(preparedAudioPath);
  const cleanupPaths = [preparedAudioPath];

  if (preparedStat.size <= maxApiFileBytes) {
    return {
      mode: isVideoFile(file) ? "video-to-audio" : "audio-compressed",
      audioSizeBytes: preparedStat.size,
      chunks: [{ path: preparedAudioPath, offsetSeconds: 0 }],
      cleanupPaths,
    };
  }

  const durationSeconds = await probeDuration(preparedAudioPath);
  const targetChunkCount = Math.max(2, Math.ceil(preparedStat.size / maxApiFileBytes));
  const chunkDurationSeconds = Math.max(60, Math.ceil(durationSeconds / targetChunkCount));
  const chunkPaths = await splitAudioIntoChunks(
    preparedAudioPath,
    chunkDurationSeconds,
    path.parse(file.filename).name
  );

  cleanupPaths.push(...chunkPaths.map((chunk) => chunk.path));

  return {
    mode: isVideoFile(file) ? "video-to-audio-chunked" : "audio-compressed-chunked",
    audioSizeBytes: preparedStat.size,
    chunks: chunkPaths,
    cleanupPaths,
  };
}

async function transcodeToSpeechAudio(inputPath, outputPath) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg is not available in the project.");
  }

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    preparedAudioSampleRate,
    "-b:a",
    preparedAudioBitrate,
    outputPath,
  ]);
}

async function splitAudioIntoChunks(inputPath, chunkDurationSeconds, baseName) {
  const outputPattern = path.join(uploadDir, `${baseName}-chunk-%03d.mp3`);

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-f",
    "segment",
    "-segment_time",
    String(chunkDurationSeconds),
    "-c",
    "copy",
    outputPattern,
  ]);

  const files = await fsp.readdir(uploadDir);
  const chunkFileNames = files
    .filter((fileName) => fileName.startsWith(`${baseName}-chunk-`) && fileName.endsWith(".mp3"))
    .sort();

  const chunks = [];

  for (let index = 0; index < chunkFileNames.length; index += 1) {
    chunks.push({
      path: path.join(uploadDir, chunkFileNames[index]),
      offsetSeconds: index * chunkDurationSeconds,
    });
  }

  if (!chunks.length) {
    throw new Error("Failed to split the prepared audio into chunks.");
  }

  return chunks;
}

async function probeDuration(filePath) {
  if (!ffprobePath) {
    throw new Error("ffprobe is not available in the project.");
  }

  const result = await runProcess(ffprobePath, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);

  const value = Number.parseFloat(result.stdout.trim());

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Could not determine audio duration.");
  }

  return value;
}

function runFfmpeg(args) {
  return runProcess(ffmpegPath, args);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || `Process failed with exit code ${code}.`));
    });
  });
}

function normalizeTranscript(transcript) {
  const text = (transcript.text || "").trim();
  const sourceSegments = Array.isArray(transcript.segments) ? transcript.segments : [];

  const segments = sourceSegments
    .filter((segment) => typeof segment.start === "number" && typeof segment.end === "number")
    .map((segment, index) => ({
      id: segment.id ?? index,
      start: segment.start,
      end: segment.end,
      startLabel: formatTimestamp(segment.start),
      endLabel: formatTimestamp(segment.end),
      text: (segment.text || "").trim(),
    }))
    .filter((segment) => segment.text);

  const durationSeconds =
    segments.length > 0 ? Math.max(...segments.map((segment) => segment.end)) : 0;

  return {
    text,
    segments,
    durationSeconds,
  };
}

async function summarizeTranscript(normalized) {
  const openai = getOpenAIClient();
  const summaryModel = process.env.SUMMARY_MODEL || "gpt-4o-mini";
  const condensedTimeline = buildCondensedTimeline(normalized.segments);
  const transcriptForSummary = normalized.text.slice(0, 30000);

  const prompt = `
You analyze transcripts of business and technical meetings and produce a concise Russian meeting brief.

Return valid JSON only with this exact shape:
{
  "overview": "string",
  "summary": ["string"],
  "tldr": "string",
  "meetingGoal": "string",
  "highlights": ["string"],
  "keyDecisions": ["string"],
  "agreements": ["string"],
  "openQuestions": ["string"],
  "actionItems": [
    {
      "owner": "string",
      "task": "string",
      "deadline": "string"
    }
  ],
  "chapters": [
    {
      "title": "string",
      "start": "MM:SS or HH:MM:SS",
      "end": "MM:SS or HH:MM:SS",
      "summary": "string"
    }
  ]
}

Rules:
- Write everything in Russian.
- Capture the actual business meaning, not generic filler.
- "overview" must be a short readable overview in 3-5 sentences.
- "summary" must contain 5-10 short bullet-style strings that retell the meeting in plain language.
- "tldr" must be 1-2 sentences with the main takeaway.
- "meetingGoal" should describe the likely purpose of the meeting. If unclear, say that the goal was not explicitly stated.
- "keyDecisions" should include only actual decisions.
- "agreements" should include only explicit agreements or alignments.
- "openQuestions" should include unresolved issues, risks, or clarifications still needed.
- "actionItems" should list concrete next steps. If no owner is known, use "Не указан". If no deadline is known, use "Не указан".
- Use provided timestamps for chapters.
- If the transcript is short, still return at least 1 chapter.
- Do not invent facts that are not supported by the transcript.
- If some block has no content, return an empty array for that block.

Transcript:
${transcriptForSummary}

Segment timeline:
${condensedTimeline}
`.trim();

  const response = await openai.responses.create({
    model: summaryModel,
    input: prompt,
  });

  const rawText = (response.output_text || "").trim();
  const parsed = safeJsonParse(extractJson(rawText));

  if (!parsed) {
    return fallbackSummary(normalized.segments);
  }

  return {
    overview: typeof parsed.overview === "string" ? parsed.overview.trim() : "",
    summary: normalizeStringArray(parsed.summary, 10),
    tldr: typeof parsed.tldr === "string" ? parsed.tldr.trim() : "",
    meetingGoal: typeof parsed.meetingGoal === "string" ? parsed.meetingGoal.trim() : "",
    highlights: normalizeStringArray(parsed.highlights, 10),
    keyDecisions: normalizeStringArray(parsed.keyDecisions, 10),
    agreements: normalizeStringArray(parsed.agreements, 10),
    openQuestions: normalizeStringArray(parsed.openQuestions, 10),
    actionItems: normalizeActionItems(parsed.actionItems),
    chapters: normalizeChapters(parsed.chapters, normalized.segments),
  };
}

function normalizeStringArray(value, maxItems = 10) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeActionItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => ({
      owner: typeof item?.owner === "string" && item.owner.trim() ? item.owner.trim() : "Не указан",
      task: typeof item?.task === "string" ? item.task.trim() : "",
      deadline:
        typeof item?.deadline === "string" && item.deadline.trim()
          ? item.deadline.trim()
          : "Не указан",
    }))
    .filter((item) => item.task);
}

function emptySummary(segments) {
  return {
    overview: "Саммари отключено для этого запуска.",
    summary: [],
    tldr: "Саммари отключено.",
    meetingGoal: "Саммари отключено.",
    highlights: [],
    keyDecisions: [],
    agreements: [],
    openQuestions: [],
    actionItems: [],
    chapters: fallbackChapters(segments),
  };
}

function fallbackSummary(segments) {
  return {
    overview: "Не удалось автоматически собрать структурированное саммари. Ниже доступен полный транскрипт встречи.",
    summary: [],
    tldr: "",
    meetingGoal: "Цель встречи не определена автоматически.",
    highlights: [],
    keyDecisions: [],
    agreements: [],
    openQuestions: [],
    actionItems: [],
    chapters: fallbackChapters(segments),
  };
}

function normalizeChapters(chapters, segments) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return fallbackChapters(segments);
  }

  const normalized = chapters
    .map((chapter, index) => ({
      id: index + 1,
      title: typeof chapter.title === "string" ? chapter.title.trim() : `Часть ${index + 1}`,
      start: typeof chapter.start === "string" ? chapter.start.trim() : "00:00",
      end:
        typeof chapter.end === "string" && chapter.end.trim()
          ? chapter.end.trim()
          : inferEndLabel(index, chapters, segments),
      summary: typeof chapter.summary === "string" ? chapter.summary.trim() : "",
    }))
    .filter((chapter) => chapter.title);

  return normalized.length > 0 ? normalized : fallbackChapters(segments);
}

function inferEndLabel(index, chapters, segments) {
  const nextChapter = chapters[index + 1];

  if (nextChapter && typeof nextChapter.start === "string" && nextChapter.start.trim()) {
    return nextChapter.start.trim();
  }

  if (segments.length > 0) {
    return formatTimestamp(segments[segments.length - 1].end);
  }

  return "00:00";
}

function fallbackChapters(segments) {
  if (!segments.length) {
    return [
      {
        id: 1,
        title: "Полный материал",
        start: "00:00",
        end: "00:00",
        summary: "Таймкоды не удалось выделить автоматически.",
      },
    ];
  }

  const chunkSize = Math.max(1, Math.ceil(segments.length / 4));
  const chapters = [];

  for (let index = 0; index < segments.length; index += chunkSize) {
    const slice = segments.slice(index, index + chunkSize);
    const first = slice[0];
    const last = slice[slice.length - 1];

    chapters.push({
      id: chapters.length + 1,
      title: `Часть ${chapters.length + 1}`,
      start: first.startLabel,
      end: last.endLabel,
      summary: slice.map((segment) => segment.text).join(" ").slice(0, 220).trim(),
    });
  }

  return chapters;
}

function buildCondensedTimeline(segments) {
  if (!segments.length) {
    return "No timestamped segments available.";
  }

  return segments
    .slice(0, 160)
    .map((segment) => `[${segment.startLabel} - ${segment.endLabel}] ${segment.text}`)
    .join("\n");
}

function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((value) => String(value).padStart(2, "0"))
      .join(":");
  }

  return [minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return text;
  }

  return text.slice(start, end + 1);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function safeDelete(filePath) {
  if (!filePath) {
    return;
  }

  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

async function cleanupRequestArtifacts(paths) {
  for (const filePath of paths) {
    await safeDelete(filePath);
  }
}

function isVideoFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  return file.mimetype.startsWith("video/") || [".mp4", ".webm", ".mov"].includes(ext);
}

function toMb(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 100) / 100;
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

function shouldIncludeSummary(value) {
  return String(value ?? "true").trim().toLowerCase() !== "false";
}

async function checkDeepgramCredentials() {
  if (!process.env.DEEPGRAM_API_KEY) {
    return {
      ok: false,
      message: "Deepgram key is missing.",
    };
  }

  try {
    const response = await fetch("https://api.deepgram.com/v1/projects", {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    });

    if (response.ok) {
      return {
        ok: true,
        message: "Deepgram key is valid.",
      };
    }

    const payload = await response.json().catch(() => null);

    return {
      ok: false,
      message:
        payload?.message || payload?.details || payload?.error || `Deepgram responded with ${response.status}.`,
    };
  } catch (error) {
    return {
      ok: false,
      message: error.message || "Deepgram check failed.",
    };
  }
}

async function checkOpenAiCredentials() {
  if (!process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      message: "OpenAI key is missing.",
    };
  }

  try {
    const openai = getOpenAIClient();
    await openai.models.list();

    return {
      ok: true,
      message: "OpenAI key is valid.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "OpenAI check failed.",
    };
  }
}

function resolveEnvPath() {
  const candidates = [
    process.env.TRANSCRIBATOR_ENV_PATH,
    process.env.PORTABLE_EXECUTABLE_DIR
      ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, ".env")
      : null,
    process.resourcesPath ? path.join(process.resourcesPath, ".env") : null,
    path.join(process.cwd(), ".env"),
    path.join(__dirname, ".env"),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

function resolveBundledBinaryPath(binaryPath) {
  if (!binaryPath) {
    return binaryPath;
  }

  const unpackedPath = binaryPath.replace("app.asar", "app.asar.unpacked");

  if (unpackedPath !== binaryPath && fs.existsSync(unpackedPath)) {
    return unpackedPath;
  }

  if (fs.existsSync(binaryPath)) {
    return binaryPath;
  }

  return binaryPath;
}

function resolveSettingsPath() {
  const candidates = [
    process.env.TRANSCRIBATOR_SETTINGS_PATH,
    process.env.PORTABLE_EXECUTABLE_DIR
      ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, "transcribator-settings.json")
      : null,
    process.resourcesPath ? path.join(process.resourcesPath, "transcribator-settings.json") : null,
    path.join(process.cwd(), "transcribator-settings.json"),
    path.join(__dirname, "transcribator-settings.json"),
  ].filter(Boolean);

  return candidates[0];
}

function loadPersistedSettings() {
  const settingsPath = resolveSettingsPath();

  if (!settingsPath || !fs.existsSync(settingsPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function persistSettings(settings) {
  const settingsPath = resolveSettingsPath();

  if (!settingsPath) {
    throw new Error("Settings path is not available.");
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
}

function applySettingsToEnv(settings) {
  const mapping = {
    openAiApiKey: "OPENAI_API_KEY",
    deepgramApiKey: "DEEPGRAM_API_KEY",
    deepgramModel: "DEEPGRAM_MODEL",
    deepgramLanguage: "DEEPGRAM_LANGUAGE",
    summaryModel: "SUMMARY_MODEL",
  };

  for (const [key, envName] of Object.entries(mapping)) {
    if (typeof settings[key] === "string") {
      process.env[envName] = settings[key];
    }
  }
}

function sanitizeSettingsPayload(payload) {
  return {
    openAiApiKey: normalizeSettingValue(payload.openAiApiKey),
    deepgramApiKey: normalizeSettingValue(payload.deepgramApiKey),
    deepgramModel: normalizeSettingValue(payload.deepgramModel, "nova-3"),
    deepgramLanguage: normalizeSettingValue(payload.deepgramLanguage, "ru"),
    summaryModel: normalizeSettingValue(payload.summaryModel, "gpt-4o-mini"),
  };
}

function normalizeSettingValue(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed || fallback;
}

function maskSecret(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= 8) {
    return "••••••••";
  }

  return `${normalized.slice(0, 4)}••••${normalized.slice(-4)}`;
}

function getDeepgramModel() {
  return process.env.DEEPGRAM_MODEL || "nova-3";
}

function getDeepgramLanguage() {
  return process.env.DEEPGRAM_LANGUAGE || "ru";
}

function getSummaryModel() {
  return process.env.SUMMARY_MODEL || "gpt-4o-mini";
}

module.exports = {
  app,
  startServer,
};

if (require.main === module) {
  startServer();
}
