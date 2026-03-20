const THEME_KEY = "transcribator-theme";
const DEFAULT_THEME = "stilt";
const THEMES = ["stilt", "neon", "noir"];

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
const submitButton = form.querySelector("button");
const themeToggle = document.querySelector("#theme-toggle");
const themeBadge = document.querySelector("#theme-badge");
const dragEvents = ["dragenter", "dragover", "dragleave", "drop"];

applyTheme(loadTheme());

themeToggle.addEventListener("click", () => {
  const currentTheme = document.body.dataset.theme;
  const currentIndex = THEMES.indexOf(currentTheme);
  const nextTheme = THEMES[(currentIndex + 1) % THEMES.length];
  applyTheme(nextTheme);
  localStorage.setItem(THEME_KEY, nextTheme);
});

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
  formData.append("media", file);

  setLoading(true);
  renderStatus(
    `Обрабатываю "${file.name}". Сначала подготовлю аудио, затем сделаю транскрипцию и соберу структурированное саммари.`
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
  return THEMES.includes(stored) ? stored : DEFAULT_THEME;
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  themeBadge.textContent = theme.toUpperCase();

  const nextTheme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  themeToggle.title = `Переключить на тему ${nextTheme.toUpperCase()}`;
}

function setLoading(isLoading) {
  submitButton.disabled = isLoading;
  submitButton.textContent = isLoading ? "Обрабатываю..." : "Сделать транскрипцию";
}

function renderStatus(message) {
  statusNode.textContent = message;
}

function renderResults(payload) {
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
