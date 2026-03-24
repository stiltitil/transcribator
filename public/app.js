const THEME_KEY = "transcribator-theme";
const DEFAULT_THEME = "stilt";

const form = document.querySelector("#upload-form");
const input = document.querySelector("#media-input");
const dropzone = document.querySelector("#dropzone");
const selectedFileNode = document.querySelector("#selected-file");
const statusNode = document.querySelector("#status");
const resultsNode = document.querySelector("#results");
const tldrNode = document.querySelector("#tldr");
const overviewNode = document.querySelector("#overview");
const meetingGoalNode = document.querySelector("#meeting-goal");
const summaryPointsNode = document.querySelector("#summary-points");
const keyDecisionsNode = document.querySelector("#key-decisions");
const agreementsNode = document.querySelector("#agreements");
const openQuestionsNode = document.querySelector("#open-questions");
const actionItemsNode = document.querySelector("#action-items");
const chaptersNode = document.querySelector("#chapters");
const transcriptNode = document.querySelector("#transcript");
const metaNode = document.querySelector("#meta");
const providerBadgeNode = document.querySelector("#provider-badge");
const includeSummaryNode = document.querySelector("#include-summary");
const downloadReportButton = document.querySelector("#download-report");
const downloadFormatNode = document.querySelector("#download-format");
const settingsToggleButton = document.querySelector("#settings-toggle");
const settingsPanel = document.querySelector("#settings-panel");
const settingsStatusNode = document.querySelector("#settings-status");
const deepgramApiKeyNode = document.querySelector("#deepgram-api-key");
const openAiApiKeyNode = document.querySelector("#openai-api-key");
const deepgramModelNode = document.querySelector("#deepgram-model");
const deepgramLanguageNode = document.querySelector("#deepgram-language");
const summaryModelNode = document.querySelector("#summary-model");
const deepgramKeyPreviewNode = document.querySelector("#deepgram-key-preview");
const openAiKeyPreviewNode = document.querySelector("#openai-key-preview");
const checkSettingsButton = document.querySelector("#check-settings");
const saveSettingsButton = document.querySelector("#save-settings");
const submitButton = form.querySelector("button");
const themeToggle = document.querySelector("#theme-toggle");
const themeBadge = document.querySelector("#theme-badge");
const dragEvents = ["dragenter", "dragover", "dragleave", "drop"];
let lastPayload = null;

applyTheme(loadTheme());
hydrateProviderBadge();
hydrateSettings();
syncDownloadButtonLabel();

themeToggle.addEventListener("click", () => {
  const nextTheme = document.body.dataset.theme === "neon" ? "stilt" : "neon";
  applyTheme(nextTheme);
  localStorage.setItem(THEME_KEY, nextTheme);
});

downloadReportButton.addEventListener("click", () => {
  if (!lastPayload) {
    renderStatus("Сначала сделай транскрипцию, потом можно будет скачать отчет.");
    return;
  }

  downloadReport(lastPayload, downloadFormatNode.value);
});

downloadFormatNode.addEventListener("change", syncDownloadButtonLabel);

settingsToggleButton.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
});

saveSettingsButton.addEventListener("click", saveSettings);
checkSettingsButton.addEventListener("click", checkSettings);

for (const eventName of dragEvents) {
  window.addEventListener(eventName, preventBrowserFileOpen, false);
  dropzone.addEventListener(eventName, preventBrowserFileOpen, false);
}

dropzone.addEventListener("dragenter", () => {
  dropzone.classList.add("is-dragging");
});

dropzone.addEventListener("dragover", () => {
  dropzone.classList.add("is-dragging");
});

dropzone.addEventListener("dragleave", (event) => {
  if (!dropzone.contains(event.relatedTarget)) {
    dropzone.classList.remove("is-dragging");
  }
});

dropzone.addEventListener("drop", (event) => {
  const files = event.dataTransfer?.files;

  dropzone.classList.remove("is-dragging");

  if (!files?.length) {
    return;
  }

  input.files = files;
  updateSelectedFile(files[0]);
});

input.addEventListener("change", () => {
  updateSelectedFile(input.files?.[0]);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = input.files?.[0];

  if (!file) {
    renderStatus("Сначала выбери файл.");
    return;
  }

  const formData = new FormData();
  formData.append("includeSummary", includeSummaryNode.checked ? "true" : "false");
  formData.append("media", file);

  setLoading(true);
  renderStatus(
    includeSummaryNode.checked
      ? `Обрабатываю "${file.name}". Сначала подготовлю аудио, затем сделаю транскрипцию и соберу структурированное саммари.`
      : `Обрабатываю "${file.name}". Сначала подготовлю аудио, затем сделаю транскрипцию без саммари.`
  );

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Ошибка сервера.");
    }

    renderResults(payload);
    renderStatus("Готово. Итоги встречи, таймкоды и транскрипт уже на экране.");
  } catch (error) {
    renderStatus(error.message || "Не удалось обработать файл.");
  } finally {
    setLoading(false);
  }
});

function loadTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "neon" || stored === "stilt" ? stored : DEFAULT_THEME;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  themeBadge.textContent = theme === "neon" ? "NEON" : "STILT";
  themeToggle.title =
    theme === "neon" ? "Переключить на тему STILT" : "Переключить на neon-тему";
}

async function hydrateProviderBadge() {
  try {
    const response = await fetch("/api/health");
    const payload = await response.json();

    if (!response.ok) {
      providerBadgeNode.textContent = "ASR: unavailable";
      return;
    }

    const asrLabel = payload?.transcriptionModel ? `ASR: ${payload.transcriptionModel}` : "ASR";
    const summaryLabel =
      payload?.summaryModel && payload?.hasSummaryKey ? `Summary: ${payload.summaryModel}` : null;

    providerBadgeNode.textContent = [asrLabel, summaryLabel].filter(Boolean).join(" • ");
  } catch {
    providerBadgeNode.textContent = "ASR: unavailable";
  }
}

async function hydrateSettings() {
  try {
    const response = await fetch("/api/settings");
    const payload = await response.json();

    if (!response.ok) {
      settingsStatusNode.textContent = "Не удалось загрузить настройки.";
      return;
    }

    fillSettingsForm(payload);
  } catch {
    settingsStatusNode.textContent = "Не удалось загрузить настройки.";
  }
}

async function saveSettings() {
  const payload = {
    deepgramApiKey: deepgramApiKeyNode.value,
    openAiApiKey: openAiApiKeyNode.value,
    deepgramModel: deepgramModelNode.value,
    deepgramLanguage: deepgramLanguageNode.value,
    summaryModel: summaryModelNode.value,
  };

  saveSettingsButton.disabled = true;
  settingsStatusNode.textContent = "Сохраняю настройки...";

  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось сохранить настройки.");
    }

    fillSettingsForm(result);
    await hydrateProviderBadge();
    settingsStatusNode.textContent = "Настройки сохранены.";
  } catch (error) {
    settingsStatusNode.textContent = error.message || "Не удалось сохранить настройки.";
  } finally {
    saveSettingsButton.disabled = false;
  }
}

async function checkSettings() {
  checkSettingsButton.disabled = true;
  settingsStatusNode.textContent = "Проверяю ключи...";

  try {
    const response = await fetch("/api/settings/check", {
      method: "POST",
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось проверить ключи.");
    }

    settingsStatusNode.textContent = [
      `Deepgram: ${result.deepgram?.ok ? "OK" : result.deepgram?.message || "error"}`,
      `OpenAI: ${result.openai?.ok ? "OK" : result.openai?.message || "error"}`,
    ].join(" • ");
  } catch (error) {
    settingsStatusNode.textContent = error.message || "Не удалось проверить ключи.";
  } finally {
    checkSettingsButton.disabled = false;
  }
}

function fillSettingsForm(payload) {
  deepgramApiKeyNode.value = payload.deepgramApiKey || "";
  openAiApiKeyNode.value = payload.openAiApiKey || "";
  deepgramModelNode.value = payload.deepgramModel || "nova-3";
  deepgramLanguageNode.value = payload.deepgramLanguage || "ru";
  summaryModelNode.value = payload.summaryModel || "gpt-4o-mini";
  deepgramKeyPreviewNode.textContent = payload.deepgramKeyPreview
    ? `Сохранен ключ: ${payload.deepgramKeyPreview}`
    : "Ключ Deepgram пока не сохранен.";
  openAiKeyPreviewNode.textContent = payload.openAiKeyPreview
    ? `Сохранен ключ: ${payload.openAiKeyPreview}`
    : "Ключ OpenAI пока не сохранен.";
  settingsStatusNode.textContent = [
    payload.hasDeepgramKey ? "Deepgram: ok" : "Deepgram: missing",
    payload.hasOpenAiKey ? "OpenAI: ok" : "OpenAI: missing",
  ].join(" • ");
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Обрабатываю..." : "Сделать транскрипцию";
}

function syncDownloadButtonLabel() {
  const format = downloadFormatNode.value || "md";
  downloadReportButton.textContent = `Скачать .${format}`;
}

function renderStatus(message) {
  statusNode.textContent = message;
}

function renderResults(payload) {
  lastPayload = payload;
  resultsNode.classList.remove("hidden");

  tldrNode.textContent = payload.tldr || "Короткое резюме не сформировано.";
  overviewNode.textContent = payload.overview || "Обзор встречи отсутствует.";
  meetingGoalNode.textContent =
    payload.meetingGoal || "Цель встречи не была определена автоматически.";
  transcriptNode.textContent = payload.transcript || "";

  metaNode.textContent = [
    payload.fileName,
    payload.metadata?.detectedLanguage ? `Язык: ${payload.metadata.detectedLanguage}` : null,
    typeof payload.metadata?.durationSeconds === "number" && payload.metadata.durationSeconds > 0
      ? `Длительность: ${formatSeconds(payload.metadata.durationSeconds)}`
      : null,
    payload.metadata?.preprocessing ? `Подготовка: ${payload.metadata.preprocessing}` : null,
    typeof payload.metadata?.chunkCount === "number" ? `Чанков: ${payload.metadata.chunkCount}` : null,
    payload.metadata?.summaryEnabled === false ? "Summary: off" : null,
  ]
    .filter(Boolean)
    .join(" • ");

  renderList(summaryPointsNode, payload.summary, "Краткий пересказ пока не сформирован.");
  renderList(keyDecisionsNode, payload.keyDecisions, "Явные решения не были выделены.");
  renderList(agreementsNode, payload.agreements, "Явные договоренности не были выделены.");
  renderList(openQuestionsNode, payload.openQuestions, "Открытые вопросы не были выделены.");
  renderActionItems(payload.actionItems || []);
  renderChapters(payload.chapters || []);
}

function renderList(node, items, emptyMessage) {
  node.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const li = document.createElement("li");
    li.textContent = emptyMessage;
    node.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    node.appendChild(li);
  }
}

function renderActionItems(items) {
  actionItemsNode.innerHTML = "";

  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("p");
    empty.className = "summary";
    empty.textContent = "Конкретные задачи не были выделены.";
    actionItemsNode.appendChild(empty);
    return;
  }

  for (const item of items) {
    const article = document.createElement("article");
    article.className = "action-item";
    article.innerHTML = `
      <strong>${escapeHtml(item.task || "Задача")}</strong>
      <div class="action-meta">Ответственный: ${escapeHtml(item.owner || "Не указан")}</div>
      <div class="action-meta">Срок: ${escapeHtml(item.deadline || "Не указан")}</div>
    `;
    actionItemsNode.appendChild(article);
  }
}

function renderChapters(chapters) {
  chaptersNode.innerHTML = "";

  for (const chapter of chapters) {
    const article = document.createElement("article");
    article.className = "chapter";
    article.innerHTML = `
      <div class="chapter-heading">
        <strong>${escapeHtml(chapter.title || "Раздел")}</strong>
        <span class="chapter-time">${escapeHtml(chapter.start || "00:00")} - ${escapeHtml(chapter.end || "00:00")}</span>
      </div>
      <div class="chapter-summary">${escapeHtml(chapter.summary || "")}</div>
    `;
    chaptersNode.appendChild(article);
  }
}

function updateSelectedFile(file) {
  selectedFileNode.textContent = file
    ? `Выбран файл: ${file.name} (${formatFileSize(file.size)})`
    : "Файл пока не выбран";
}

function preventBrowserFileOpen(event) {
  event.preventDefault();
  event.stopPropagation();
}

function formatSeconds(value) {
  const totalSeconds = Math.floor(Number(value) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, seconds].map((item) => String(item).padStart(2, "0")).join(":");
  }

  return [minutes, seconds].map((item) => String(item).padStart(2, "0")).join(":");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);

  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function downloadReport(payload, format) {
  const exportPayload = buildExportPayload(payload, format);
  const blob = new Blob([exportPayload.content], { type: exportPayload.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const safeBase = getSafeExportBaseName(payload);

  anchor.href = url;
  anchor.download = `${safeBase || "transcript"}-report.${exportPayload.extension}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function buildExportPayload(payload, format) {
  switch (format) {
    case "txt":
      return {
        content: buildTextReport(payload),
        extension: "txt",
        mimeType: "text/plain;charset=utf-8",
      };
    case "srt":
      return {
        content: buildSrtReport(payload),
        extension: "srt",
        mimeType: "application/x-subrip;charset=utf-8",
      };
    case "json":
      return {
        content: `${JSON.stringify(buildJsonReport(payload), null, 2)}\n`,
        extension: "json",
        mimeType: "application/json;charset=utf-8",
      };
    case "md":
    default:
      return {
        content: buildMarkdownReport(payload),
        extension: "md",
        mimeType: "text/markdown;charset=utf-8",
      };
  }
}

function getSafeExportBaseName(payload) {
  return String(payload.fileName || "transcript")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9-_а-яА-ЯёЁ]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildMarkdownReport(payload) {
  const hashtags = buildHashtags(payload);
  const lines = [
    `# ${payload.fileName || "Transcribator Report"}`,
    "",
    `Дата экспорта: ${new Date().toLocaleString("ru-RU")}`,
    payload.metadata?.transcriptionModel ? `ASR: ${payload.metadata.transcriptionModel}` : null,
    payload.metadata?.summaryModel && payload.metadata?.summaryEnabled !== false
      ? `Summary model: ${payload.metadata.summaryModel}`
      : "Summary: off",
    typeof payload.metadata?.durationSeconds === "number" && payload.metadata.durationSeconds > 0
      ? `Длительность: ${formatSeconds(payload.metadata.durationSeconds)}`
      : null,
    payload.metadata?.detectedLanguage ? `Язык: ${payload.metadata.detectedLanguage}` : null,
    hashtags.length ? `Хештеги: ${hashtags.join(" ")}` : null,
    "",
    "## TL;DR",
    payload.tldr || "Саммари не сформировано.",
    "",
    "## Обзор встречи",
    payload.overview || "Нет данных.",
    "",
    "## Цель созвона",
    payload.meetingGoal || "Нет данных.",
    "",
    "## Краткий пересказ",
    ...toBulletLines(payload.summary, "Нет данных."),
    "",
    "## Ключевые решения",
    ...toBulletLines(payload.keyDecisions, "Нет данных."),
    "",
    "## Договоренности",
    ...toBulletLines(payload.agreements, "Нет данных."),
    "",
    "## Открытые вопросы",
    ...toBulletLines(payload.openQuestions, "Нет данных."),
    "",
    "## Задачи",
    ...toActionItemLines(payload.actionItems),
    "",
    "## Таймкоды",
    ...toChapterLines(payload.chapters),
    "",
    "## Транскрипт",
    payload.transcript || "",
  ];

  return lines.filter((line) => line !== null).join("\n");
}

function buildTextReport(payload) {
  const hashtags = buildHashtags(payload);
  const lines = [
    payload.fileName || "Transcribator Report",
    "",
    `Дата экспорта: ${new Date().toLocaleString("ru-RU")}`,
    payload.metadata?.transcriptionModel ? `ASR: ${payload.metadata.transcriptionModel}` : null,
    payload.metadata?.summaryModel && payload.metadata?.summaryEnabled !== false
      ? `Summary model: ${payload.metadata.summaryModel}`
      : "Summary: off",
    typeof payload.metadata?.durationSeconds === "number" && payload.metadata.durationSeconds > 0
      ? `Длительность: ${formatSeconds(payload.metadata.durationSeconds)}`
      : null,
    payload.metadata?.detectedLanguage ? `Язык: ${payload.metadata.detectedLanguage}` : null,
    hashtags.length ? `Хештеги: ${hashtags.join(" ")}` : null,
    "",
    "TL;DR",
    payload.tldr || "Саммари не сформировано.",
    "",
    "Обзор встречи",
    payload.overview || "Нет данных.",
    "",
    "Цель созвона",
    payload.meetingGoal || "Нет данных.",
    "",
    "Краткий пересказ",
    ...toBulletLines(payload.summary, "Нет данных.").map((line) => line.replace(/^- /, "• ")),
    "",
    "Ключевые решения",
    ...toBulletLines(payload.keyDecisions, "Нет данных.").map((line) => line.replace(/^- /, "• ")),
    "",
    "Договоренности",
    ...toBulletLines(payload.agreements, "Нет данных.").map((line) => line.replace(/^- /, "• ")),
    "",
    "Открытые вопросы",
    ...toBulletLines(payload.openQuestions, "Нет данных.").map((line) => line.replace(/^- /, "• ")),
    "",
    "Задачи",
    ...toActionItemLines(payload.actionItems).map((line) => line.replace(/^- /, "• ")),
    "",
    "Таймкоды",
    ...toChapterLines(payload.chapters).map((line) => line.replace(/^- /, "• ")),
    "",
    "Транскрипт",
    payload.transcript || "",
  ];

  return lines.filter((line) => line !== null).join("\n");
}

function buildSrtReport(payload) {
  const chapters = Array.isArray(payload.chapters) ? payload.chapters : [];

  if (chapters.length) {
    return chapters
      .map((chapter, index) => {
        const start = normalizeTimestamp(chapter.start);
        const end = normalizeTimestamp(chapter.end || chapter.start);
        const content = [chapter.title || "Раздел", chapter.summary || ""].filter(Boolean).join("\n");

        return [String(index + 1), `${start} --> ${end}`, content].join("\n");
      })
      .join("\n\n");
  }

  const fallbackText = payload.transcript || payload.overview || payload.tldr || "Transcript unavailable.";
  const totalDuration = typeof payload.metadata?.durationSeconds === "number" && payload.metadata.durationSeconds > 0
    ? payload.metadata.durationSeconds
    : 0;

  return [
    "1",
    `${normalizeTimestamp("00:00")} --> ${normalizeTimestamp(totalDuration ? formatSeconds(totalDuration) : "00:30")}`,
    fallbackText,
  ].join("\n");
}

function buildJsonReport(payload) {
  return {
    exportedAt: new Date().toISOString(),
    hashtags: buildHashtags(payload),
    ...payload,
  };
}

function toBulletLines(items, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    return [`- ${emptyText}`];
  }

  return items.map((item) => `- ${item}`);
}

function toActionItemLines(items) {
  if (!Array.isArray(items) || !items.length) {
    return ["- Нет данных."];
  }

  return items.map((item) => {
    const owner = item.owner || "Не указан";
    const deadline = item.deadline || "Не указан";
    return `- ${item.task} | Ответственный: ${owner} | Срок: ${deadline}`;
  });
}

function toChapterLines(chapters) {
  if (!Array.isArray(chapters) || !chapters.length) {
    return ["- Нет данных."];
  }

  return chapters.flatMap((chapter) => [
    `- [${chapter.start || "00:00"} - ${chapter.end || "00:00"}] ${chapter.title || "Раздел"}`,
    chapter.summary ? `  ${chapter.summary}` : null,
  ]).filter(Boolean);
}

function normalizeTimestamp(value) {
  const input = String(value || "00:00").trim().replace(",", ".");
  const parts = input.split(":").map((part) => part.trim());
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    hours = Number(parts[0]) || 0;
    minutes = Number(parts[1]) || 0;
    seconds = Number(parts[2]) || 0;
  } else if (parts.length === 2) {
    minutes = Number(parts[0]) || 0;
    seconds = Number(parts[1]) || 0;
  } else {
    seconds = Number(parts[0]) || 0;
  }

  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const milliseconds = Math.max(0, Math.round((seconds - wholeSeconds) * 1000));

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(wholeSeconds).padStart(2, "0"),
  ].join(":") + `,${String(milliseconds).padStart(3, "0")}`;
}

function buildHashtags(payload) {
  const source = [
    ...(Array.isArray(payload.keyDecisions) ? payload.keyDecisions : []),
    ...(Array.isArray(payload.agreements) ? payload.agreements : []),
    ...(Array.isArray(payload.openQuestions) ? payload.openQuestions : []),
    ...(Array.isArray(payload.chapters) ? payload.chapters.map((chapter) => chapter.title) : []),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, " ");

  const stopwords = new Set([
    "и", "в", "во", "на", "по", "с", "со", "к", "ко", "из", "за", "для", "не", "но",
    "это", "что", "как", "под", "над", "от", "до", "или", "а", "у", "о", "об", "про",
  ]);

  const words = source
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stopwords.has(word));

  return [...new Set(words)].slice(0, 10).map((word) => `#${word}`);
}
