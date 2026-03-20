const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const dotenv = require("dotenv");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const ffprobe = require("ffprobe-static");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const uploadDir = path.join(__dirname, "uploads");
const maxUploadBytes = Number(process.env.MAX_UPLOAD_MB || 512) * 1024 * 1024;
const maxApiFileBytes = 24 * 1024 * 1024;
const preparedAudioBitrate = process.env.AUDIO_BITRATE || "48k";
const preparedAudioSampleRate = process.env.AUDIO_SAMPLE_RATE || "16000";

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

if (!process.env.OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is missing. API routes will fail until it is set.");
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
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
    transcriptionModel: process.env.TRANSCRIPTION_MODEL || "whisper-1",
    summaryModel: process.env.SUMMARY_MODEL || "gpt-4o-mini",
  });
});

app.post("/api/transcribe", upload.single("media"), async (req, res) => {
  let cleanupPaths = [];

  if (!process.env.OPENAI_API_KEY) {
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
    const summary = await summarizeTranscript(normalized);

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
        transcriptionModel: process.env.TRANSCRIPTION_MODEL || "whisper-1",
        summaryModel: process.env.SUMMARY_MODEL || "gpt-4o-mini",
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

app.listen(port, () => {
  console.log(`Transcribator is running on http://localhost:${port}`);
});

async function transcribeFile(filePath) {
  const openai = getOpenAIClient();
  const transcriptionModel = process.env.TRANSCRIPTION_MODEL || "whisper-1";

  const response = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: transcriptionModel,
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });

  return response;
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
  if (!ffprobe?.path) {
    throw new Error("ffprobe is not available in the project.");
  }

  const result = await runProcess(ffprobe.path, [
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
