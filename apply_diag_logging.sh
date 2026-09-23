#!/usr/bin/env bash
set -euo pipefail
# apply_diag_logging.sh — запускать из КОРНЯ репозитория todo-tracker-bot:
#   bash apply_diag_logging.sh
if [ ! -d src ] || [ ! -f package.json ]; then
  echo "Нет src/ или package.json. Запусти из корня репозитория."; exit 1
fi
echo "-> Записываю файлы..."
mkdir -p "src/services"
cat > "src/services/gemini.ts" <<'EOF_src_services_gemini_ts_'
import { config } from "../config";
import type { GeminiTask } from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_RETRIES = 3;
/** Таймаут одного запроса к API. Переопределяется env LLM_TIMEOUT_MS. */
export const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 120_000;
/** Модель. Переопределяется env LLM_MODEL. */
export const MODEL = process.env.LLM_MODEL || "claude-fable-5-1";
/** Статусы, при которых повтор бессмысленен (ключ, модель, формат запроса). */
const NON_RETRYABLE = new Set([400, 401, 403, 404, 413]);

// ─── Промт 1: Генерация MoM ───

function buildMomPrompt(fileName: string): string {
  const today = formatDate(new Date());
  const nextWeek = formatDate(addDays(new Date(), 7));

  return `Изучи транскрипцию со встречи. На основе только этой транскрипции, сделай минутки встречи с договоренностями и задачами, ничего не добавляй от себя и не выдумывай.

Название встречи — название файла без слова "транскрипция": "${fileName}".
Встреча от сегодня (${today}).

Пункт "DDL" ставь +неделя от сегодня (${nextWeek}) или ориентируйся на слова, которые говорили на встрече (например "до конца недели" = до следующей пятницы).

К каждой минутке добавляй ссылку на место в транскрипции, откуда она.

Формат минуток (сделай красиво, построчно):

MN "[Название встречи]" от ${today}

Задачи и DDL:
@Ответственный (Команда/Роль): описание задачи DDL ДД.ММ.ГГГГ.
@Ответственный (Команда/Роль): описание задачи DDL ДД.ММ.ГГГГ.

Ничего не добавляй от себя и не выдумывай. Только факты из транскрипции.`;
}

// ─── Промт 2: Извлечение задач в JSON ───

const EXTRACT_TASKS_PROMPT = `Из текста минуток встречи ниже извлеки все задачи и верни СТРОГО в формате JSON (без markdown-обёрток, без backticks).

Формат:
[
  {
    "task": "Полное описание задачи",
    "assignee": "Ответственный (с @ если есть)",
    "deadline": "ДД.ММ.ГГГГ",
    "comment": "Команда/роль, контекст или зависимости"
  }
]

Правила:
- Извлекай ТОЛЬКО конкретные задачи с DDL.
- Дедлайн должен быть в формате ДД.ММ.ГГГГ. Если формат другой (например "СА MVP 2"), запиши его в comment, а deadline оставь пустой строкой.
- Возвращай ТОЛЬКО валидный JSON-массив.`;

// ─── Публичные функции ───

export async function generateMom(
  transcriptionText: string,
  fileName: string
): Promise<string> {
  const systemPrompt = buildMomPrompt(fileName);
  return callClaude(systemPrompt, `Вот транскрипция встречи:\n\n${transcriptionText}`);
}

export async function extractTasksFromMom(momText: string): Promise<GeminiTask[]> {
  const rawResponse = await callClaude(EXTRACT_TASKS_PROMPT, momText);
  return parseTasksJson(rawResponse);
}

// ─── Claude API call with retry ───

async function callClaude(systemPrompt: string, userMessage: string): Promise<string> {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  const inputChars = systemPrompt.length + userMessage.length;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const started = Date.now();
    try {
      console.log(`[claude] attempt ${attempt}/${MAX_RETRIES} model=${MODEL} input=${inputChars} chars timeout=${TIMEOUT_MS}ms`);
      const response = await fetchWithTimeout(
        ANTHROPIC_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.anthropicApiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        },
        TIMEOUT_MS
      );

      const elapsed = Date.now() - started;

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[claude] attempt ${attempt} HTTP ${response.status} in ${elapsed}ms: ${errorBody.slice(0, 500)}`);
        if (NON_RETRYABLE.has(response.status)) {
          throw new ClaudeApiError(response.status, errorBody);
        }
        throw new Error(`HTTP ${response.status}: ${errorBody.slice(0, 200)}`);
      }

      const data: any = await response.json();
      const textBlock = data?.content?.find((b: any) => b.type === "text");
      console.log(`[claude] attempt ${attempt} OK in ${elapsed}ms, stop=${data?.stop_reason}, out=${data?.usage?.output_tokens ?? "?"} tok`);
      return textBlock?.text ?? "";
    } catch (error) {
      if (error instanceof ClaudeApiError) throw error; // повторять бессмысленно

      const elapsed = Date.now() - started;
      const err = error as Error;
      const isAbort = err?.name === "AbortError" || /aborted/i.test(err?.message ?? "");
      lastError = isAbort
        ? new Error(`таймаут ${Math.round(elapsed / 1000)} с (лимит ${TIMEOUT_MS / 1000} с)`)
        : err;
      console.error(`[claude] attempt ${attempt} FAILED in ${elapsed}ms: ${err?.name}: ${err?.message}`);
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }

  throw new GeminiTimeoutError(lastError?.message);
}

// ─── Диагностика: минимальный вызов API ───

export interface ClaudePing {
  ok: boolean;
  status?: number;
  ms: number;
  model: string;
  detail: string;
}

/** Один короткий запрос без retry — чтобы понять, доступен ли API вообще. */
export async function pingClaude(): Promise<ClaudePing> {
  const started = Date.now();
  try {
    const response = await fetchWithTimeout(
      ANTHROPIC_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 5,
          messages: [{ role: "user", content: "Ответь одним словом: ок" }],
        }),
      },
      Math.min(TIMEOUT_MS, 30_000)
    );
    const ms = Date.now() - started;
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      ms,
      model: MODEL,
      detail: response.ok ? "ответ получен" : text.slice(0, 300),
    };
  } catch (error) {
    const err = error as Error;
    return {
      ok: false,
      ms: Date.now() - started,
      model: MODEL,
      detail: `${err?.name}: ${err?.message}`,
    };
  }
}

// ─── Парсинг JSON-задач ───

function parseTasksJson(raw: string): GeminiTask[] {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

  let tasks: GeminiTask[];
  try {
    tasks = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude вернул невалидный JSON при извлечении задач.\nОтвет:\n${raw.slice(0, 500)}`);
  }

  if (!Array.isArray(tasks)) throw new Error("Ожидался JSON-массив задач.");
  return tasks.map(normalizeTask);
}

function normalizeTask(task: GeminiTask): GeminiTask {
  const dateRegex = /^\d{2}\.\d{2}\.\d{4}$/;
  if (task.deadline && dateRegex.test(task.deadline)) return task;

  const fallbackStr = formatDate(addDays(new Date(), 7));
  const originalNote = task.deadline?.trim() ? ` (оригинал: "${task.deadline}")` : "";

  return {
    ...task,
    deadline: fallbackStr,
    comment: task.comment
      ? `${task.comment} | Требует ручного уточнения даты${originalNote}`
      : `Требует ручного уточнения даты${originalNote}`,
  };
}

// ─── Утилиты ───

function addDays(date: Date, days: number): Date {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function formatDate(date: Date): string {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${d}.${m}.${date.getFullYear()}`;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ошибка API, при которой retry не поможет: неверный ключ, недоступная модель, плохой запрос. */
export class ClaudeApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    let reason = body.slice(0, 200);
    try {
      const parsed = JSON.parse(body);
      reason = parsed?.error?.message ?? reason;
    } catch { /* не JSON — оставляем как есть */ }
    const hint =
      status === 401 ? "Проверьте ANTHROPIC_API_KEY в настройках Render." :
      status === 404 ? `Модель "${MODEL}" недоступна для этого ключа. Задайте другую через env LLM_MODEL.` :
      status === 400 ? "Запрос отклонён API — возможно, слишком длинный текст." :
      "";
    super(`❌ Ошибка API (${status}): ${reason}${hint ? `\n${hint}` : ""}`);
    this.name = "ClaudeApiError";
    this.status = status;
  }
}

export class GeminiTimeoutError extends Error {
  constructor(detail?: string) {
    super(`Не удалось получить ответ после ${MAX_RETRIES} попыток.${detail ? ` Причина: ${detail}` : ""}`);
    this.name = "GeminiTimeoutError";
  }
}

/**
 * Универсальный JSON-вызов Claude: системный промт + парсинг JSON-ответа.
 * Снимает markdown-обёртки так же, как parseTasksJson.
 */
export async function extractJsonFromClaude<T>(systemPrompt: string): Promise<T> {
  const raw = await callClaude(systemPrompt, "Верни только JSON.");
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as T;
}

EOF_src_services_gemini_ts_
echo "   ok  src/services/gemini.ts"
mkdir -p "src/bot/handlers"
cat > "src/bot/handlers/flow.ts" <<'EOF_src_bot_handlers_flow_ts_'
import { Composer } from "grammy";
import type { BotContext } from "../context";
import {
  getUserProjects,
  createSession,
  getActiveSession,
  updateSessionDraft,
  updateSessionStatus,
} from "../../db";
import { extractTextFromPdf, PdfNoTextError } from "../../services/pdf";
import {
  generateMom,
  extractTasksFromMom,
  GeminiTimeoutError,
  ClaudeApiError,
} from "../../services/gemini";
import { exportTasksToSheet, SheetsAccessError } from "../../services/sheets";
import { projectSelectKeyboard, reviewKeyboard } from "../keyboards";

export const flowHandlers = new Composer<BotContext>();
const TG_LIMIT = 4000;

function splitText(text: string, max = TG_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

// ─── 1. PDF Upload ───

flowHandlers.on("message:document", async (ctx) => {
  const doc = ctx.message.document;

  if (doc.mime_type !== "application/pdf") {
    await ctx.reply("📄 Пожалуйста, отправьте файл в формате PDF.");
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const projects = await getUserProjects(telegramId);

  if (projects.length === 0) {
    await ctx.reply("У вас нет проектов. Сначала добавьте проект командой /add_project");
    return;
  }

  // Download and store PDF buffer + file name in session
  const file = await ctx.api.getFile(doc.file_id);
  const url = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  ctx.session.pdfBuffer = Array.from(new Uint8Array(arrayBuffer));
  ctx.session.pdfFileName = doc.file_name ?? "Встреча";

  await ctx.reply("📂 Выберите проект для этой транскрипции:", {
    reply_markup: projectSelectKeyboard(projects),
  });
});

// ─── 2. Project Selection → Gemini MoM ───

flowHandlers.callbackQuery(/^select_project:(.+)$/, async (ctx) => {
  const projectId = ctx.match![1];
  const pdfBytes = ctx.session.pdfBuffer;
  const fileName = ctx.session.pdfFileName ?? "Встреча";

  if (!pdfBytes) {
    await ctx.answerCallbackQuery("Файл не найден. Отправьте PDF заново.");
    return;
  }

  ctx.session.pdfBuffer = null;
  ctx.session.pdfFileName = null;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("⏳ Анализирую документ с Gemini...");

  try {
    const buffer = Buffer.from(pdfBytes);
    const text = await extractTextFromPdf(buffer);
    console.log(`[flow] pdf "${fileName}": ${buffer.length} bytes → ${text.length} chars text`);

    // Step 1: Generate human-readable MoM with user's prompt
    const momText = await generateMom(text, fileName);
    console.log(`[flow] MoM generated: ${momText.length} chars`);

    // Save MoM in session for later export
    const telegramId = BigInt(ctx.from!.id);
    await createSession(telegramId, projectId, momText);

    // Send MoM for review (plain text, not parsed)
        const parts = splitText(momText);
    await ctx.editMessageText(
      parts[0],
      parts.length === 1 ? { reply_markup: reviewKeyboard() } : undefined
    );
    for (let i = 1; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      await ctx.reply(parts[i], isLast ? { reply_markup: reviewKeyboard() } : undefined);
    }

    await ctx.reply("Если нужны правки — просто отправь мне исправленный текст ответным сообщением.");
  } catch (error) {
    console.error("[flow] select_project failed:", error);
    if (
      error instanceof PdfNoTextError ||
      error instanceof GeminiTimeoutError ||
      error instanceof ClaudeApiError
    ) {
      await ctx.editMessageText(error.message);
    } else {
      await ctx.editMessageText("❌ Произошла ошибка при обработке документа. Попробуйте ещё раз.");
    }
  }
});

// ─── Manual Project Selection ───

flowHandlers.callbackQuery(/^manual_project:(.+)$/, async (ctx) => {
  const projectId = ctx.match![1];
  ctx.session.manualTaskProjectId = projectId;
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "✏️ Отправьте задачи в формате:\n\n" +
    "@Ответственный: описание задачи DDL ДД.ММ.ГГГГ\n" +
    "@Ответственный: описание задачи DDL ДД.ММ.ГГГГ\n\n" +
    "Или в любом текстовом формате — я извлеку задачи автоматически."
  );
});

// ─── 3. MoM Text Edits ───

flowHandlers.on("message:text", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);

  // Handle manual task entry
  if (ctx.session.manualTaskProjectId) {
    const projectId = ctx.session.manualTaskProjectId;
    ctx.session.manualTaskProjectId = null;

    const { getProjectById } = await import("../../db");
    const project = await getProjectById(projectId);
    if (!project) {
      await ctx.reply("❌ Проект не найден.");
      return;
    }

    await ctx.reply("⏳ Извлекаю задачи...");

    try {
      const tasks = await extractTasksFromMom(ctx.message.text);
      const count = await exportTasksToSheet(project.spreadsheetId, tasks);
      await ctx.reply(`✅ ${count} задач(и) успешно добавлены в таблицу проекта "${project.projectName}".`);
    } catch (error) {
      console.error("[flow] manual task failed:", error);
      if (
        error instanceof SheetsAccessError ||
        error instanceof ClaudeApiError ||
        error instanceof GeminiTimeoutError
      ) {
        await ctx.reply(error.message);
      } else {
        await ctx.reply("❌ Не удалось извлечь задачи. Проверьте формат и попробуйте ещё раз.");
      }
    }
    return;
  }

  const session = await getActiveSession(telegramId);
  if (!session) return;

  // User sent corrected MoM text — save as new draft
  const editedText = ctx.message.text;
  await updateSessionDraft(session.id, editedText);

    const parts = splitText("Правки приняты. Вот обновлённый вариант:\n\n" + editedText);
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    await ctx.reply(parts[i], isLast ? { reply_markup: reviewKeyboard() } : undefined);
  }
});

// ─── 4. Export to Google Sheets ───

flowHandlers.callbackQuery("export_tasks", async (ctx) => {
  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);
  const session = await getActiveSession(telegramId);

  if (!session) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply("Нет активной сессии для экспорта.");
    return;
  }

  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.reply("⏳ Извлекаю задачи для таблицы...");

    // Step 2: Extract structured tasks from MoM text via Gemini
    const tasks = await extractTasksFromMom(session.momDraft);

    const count = await exportTasksToSheet(
      session.project.spreadsheetId,
      tasks
    );

    await updateSessionStatus(session.id, "exported");
    await ctx.reply(`✅ ${count} задач(и) успешно добавлены в таблицу проекта "${session.project.projectName}".`);
  } catch (error) {
    console.error("[flow] export_tasks failed:", error);
    if (error instanceof SheetsAccessError || error instanceof ClaudeApiError) {
      await ctx.reply(error.message);
    } else if (error instanceof GeminiTimeoutError) {
      await ctx.reply("❌ Не удалось извлечь задачи. " + error.message);
    } else {
      await ctx.reply("❌ Ошибка при экспорте. Попробуйте ещё раз.");
    }
  }
});

// ─── 5. Cancel Review ───

flowHandlers.callbackQuery("cancel_review", async (ctx) => {
  await ctx.answerCallbackQuery("Отменено.");
  const telegramId = BigInt(ctx.from!.id);
  const session = await getActiveSession(telegramId);
  if (session) await updateSessionStatus(session.id, "approved");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  await ctx.reply("🚫 Экспорт отменён.");
});
EOF_src_bot_handlers_flow_ts_
echo "   ok  src/bot/handlers/flow.ts"
mkdir -p "src/bot/handlers"
cat > "src/bot/handlers/commands.ts" <<'EOF_src_bot_handlers_commands_ts_'
import { Composer } from "grammy";
import { invalidateClusters } from "../../services/person-resolver";
import type { BotContext } from "../context";
import {
  findOrCreateUser,
  getUserProjects,
  addProject,
  updateNotifyTime,
} from "../../db";
import { extractSpreadsheetId, validateSheetAccess, getTodayTasks } from "../../services/sheets";
import { pingClaude, MODEL, TIMEOUT_MS } from "../../services/gemini";
import { config } from "../../config";
import { projectSelectKeyboardManual } from "../keyboards";

export const commandHandlers = new Composer<BotContext>();

// ─── /start ───

commandHandlers.command("start", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  await findOrCreateUser(telegramId);

  const projects = await getUserProjects(telegramId);

  if (projects.length === 0) {
    await ctx.reply(
      "👋 Привет! Я помогу отслеживать задачи из ваших встреч.\n\n" +
        "Для начала добавьте проект командой /add_project\n\n" +
        "Формат: Название проекта - Ссылка на Google Таблицу"
    );
  } else {
    const list = projects.map((p, i) => `${i + 1}. ${p.projectName}`).join("\n");
    await ctx.reply(
      `👋 С возвращением! Ваши проекты:\n\n${list}\n\n` +
        "Отправьте PDF-транскрипцию, чтобы начать.\n" +
        "Или добавьте ещё проект: /add_project"
    );
  }
});

// ─── /add_project ───

commandHandlers.command("add_project", async (ctx) => {
  ctx.session.awaitingProject = true;
  await ctx.reply(
    "📁 Отправьте название проекта и ссылку на Google Таблицу в формате:\n\n" +
      "`Название проекта - https://docs.google.com/spreadsheets/d/.../edit`",
    { parse_mode: "Markdown" }
  );
});

// ─── /digest ───

commandHandlers.command("digest", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  const projects = await getUserProjects(telegramId);

  if (projects.length === 0) {
    await ctx.reply("У вас нет проектов. Добавьте через /add_project");
    return;
  }

  await ctx.reply("⏳ Собираю дайджест...");

  const allTasks: { project: string; tasks: any[] }[] = [];

  for (const project of projects) {
    try {
      const tasks = await getTodayTasks(project.spreadsheetId);
      if (tasks.length > 0) {
        allTasks.push({ project: project.projectName, tasks });
      }
    } catch (error) {
      console.error(`Digest error for project ${project.projectName}:`, error);
    }
  }

  if (allTasks.length === 0) {
    await ctx.reply("✅ Нет задач на сегодня и просроченных задач!");
    return;
  }

  let msg = "🔔 *Дайджест задач на сегодня:*\n\n";

  for (const { project, tasks } of allTasks) {
    msg += `📁 *${project}*\n`;
    for (const t of tasks) {
      const prefix = t.isOverdue ? "🔴 ПРОСРОЧЕНО: " : "• ";
      msg += `  ${prefix}${escapeMarkdown(t.task)} — 👤 ${escapeMarkdown(t.assignee)} (DDL: ${t.deadline})\n`;
    }
    msg += "\n";
  }

  const chunks = splitMessage(msg, 4000);
  for (const chunk of chunks) {
    await ctx.reply(chunk, { parse_mode: "Markdown" });
  }
});

// ─── /diag — проверка окружения и доступности API ───

commandHandlers.command("diag", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  const sent = await ctx.reply("🩺 Проверяю окружение и API…");

  const lines: string[] = [
    `Node ${process.version}, uptime ${Math.round(process.uptime())} с`,
    `TZ сервера: ${process.env.TZ ?? "не задана"} (сейчас ${new Date().toTimeString().slice(0, 5)})`,
    `LLM: ${MODEL}, таймаут ${TIMEOUT_MS / 1000} с`,
    `Ключ API: ${config.anthropicApiKey ? `задан (…${config.anthropicApiKey.slice(-4)})` : "НЕТ"}`,
    `Сервисный email Sheets: ${config.google.serviceAccountEmail}`,
    "",
  ];

  const ping = await pingClaude();
  lines.push(
    ping.ok
      ? `✅ Claude API отвечает за ${ping.ms} мс`
      : `❌ Claude API: ${ping.status ? `HTTP ${ping.status}, ` : ""}${ping.detail} (${ping.ms} мс)`
  );

  const projects = await getUserProjects(telegramId);
  if (projects.length > 0) {
    const p = projects[0];
    try {
      await validateSheetAccess(p.spreadsheetId);
      lines.push(`✅ Google Sheets: доступ к таблице "${p.projectName}" есть`);
    } catch (error: any) {
      lines.push(`❌ Google Sheets ("${p.projectName}"): ${error?.message ?? error}`);
    }
  } else {
    lines.push("ℹ️ Проектов нет — проверку Sheets пропускаю");
  }

  console.log("[diag]", lines.join(" | "));
  await ctx.api.editMessageText(sent.chat.id, sent.message_id, lines.join("\n"));
});

// ─── /add_task ───

commandHandlers.command("add_task", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  const projects = await getUserProjects(telegramId);

  if (projects.length === 0) {
    await ctx.reply("У вас нет проектов. Добавьте через /add_project");
    return;
  }

  await ctx.reply("📁 Выберите проект для добавления задач:", {
    reply_markup: projectSelectKeyboardManual(projects),
  });
});

// ─── /projects ───

commandHandlers.command("projects", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  const projects = await getUserProjects(telegramId);

  if (projects.length === 0) {
    await ctx.reply("У вас нет проектов. Добавьте через /add_project");
    return;
  }

  let msg = "📁 *Ваши проекты:*\n\n";
  projects.forEach((p, i) => {
    const link = `https://docs.google.com/spreadsheets/d/${p.spreadsheetId}/edit`;
    msg += `${i + 1}. *${p.projectName}*\n   🔗 [Открыть таблицу](${link})\n\n`;
  });

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

// ─── /settings ───

commandHandlers.command("settings", async (ctx) => {
  ctx.session.awaitingNotifyTime = true;
  const telegramId = BigInt(ctx.from!.id);
  const user = await findOrCreateUser(telegramId);

  await ctx.reply(
    `⚙️ Текущее время дайджеста: *${user.notifyTime}*\n\n` +
      "Отправьте новое время в формате HH:MM (например, 09:30)",
    { parse_mode: "Markdown" }
  );
});

// ─── Text message handler for /add_project and /settings flows ───

commandHandlers.on("message:text", async (ctx, next) => {
  // Handle /add_project input
  if (ctx.session.awaitingProject) {
    ctx.session.awaitingProject = false;

    const text = ctx.message.text;
    const separatorIndex = text.lastIndexOf(" - ");

    if (separatorIndex === -1) {
      await ctx.reply(
        "❌ Неверный формат. Используйте:\n`Название - Ссылка на таблицу`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const name = text.slice(0, separatorIndex).trim();
    const url = text.slice(separatorIndex + 3).trim();
    const spreadsheetId = extractSpreadsheetId(url);

    if (!spreadsheetId) {
      await ctx.reply("❌ Не удалось извлечь ID таблицы из ссылки. Проверьте URL.");
      return;
    }

    try {
      await validateSheetAccess(spreadsheetId);
    } catch (error: any) {
      await ctx.reply(error.message);
      return;
    }

    const telegramId = BigInt(ctx.from!.id);
    await addProject(telegramId, name, spreadsheetId);
    invalidateClusters(String(telegramId));
    await ctx.reply(`✅ Проект "${name}" успешно добавлен!`);
    return;
  }

  // Handle /settings input
  if (ctx.session.awaitingNotifyTime) {
    ctx.session.awaitingNotifyTime = false;

    const time = ctx.message.text.trim();
    if (!/^\d{2}:\d{2}$/.test(time)) {
      await ctx.reply("❌ Неверный формат. Отправьте время как HH:MM (например, 09:30)");
      return;
    }

    const [hours, minutes] = time.split(":").map(Number);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      await ctx.reply("❌ Некорректное время. Часы: 00-23, минуты: 00-59.");
      return;
    }

    const telegramId = BigInt(ctx.from!.id);
    await updateNotifyTime(telegramId, time);
    await ctx.reply(`✅ Время дайджеста обновлено: *${time}*`, {
      parse_mode: "Markdown",
    });
    return;
  }

  // Not a command flow — pass to next handler (MoM edits)
  await next();
});

function escapeMarkdown(text: string): string {
  return text.replace(/([*_`\[\]])/g, "\\$1");
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let current = text;
  while (current.length > maxLength) {
    let splitAt = current.lastIndexOf("\n", maxLength);
    if (splitAt === -1) splitAt = maxLength;
    chunks.push(current.slice(0, splitAt));
    current = current.slice(splitAt);
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
EOF_src_bot_handlers_commands_ts_
echo "   ok  src/bot/handlers/commands.ts"
mkdir -p "src"
cat > "src/index.ts" <<'EOF_src_index_ts_'
import { Bot, session } from "grammy";
import { config } from "./config";
import { type BotContext, initialSession } from "./bot/context";
import { commandHandlers } from "./bot/handlers/commands";
import { tasksHandlers } from "./bot/handlers/tasks";
import { flowHandlers } from "./bot/handlers/flow";
import { startDigestJob } from "./jobs/digest";
import { MODEL, TIMEOUT_MS } from "./services/gemini";
import { createServer } from "http";

async function main() {
  const bot = new Bot<BotContext>(config.telegramBotToken);

  bot.use(session({ initial: initialSession }));
  bot.use(commandHandlers);
  bot.use(tasksHandlers);
  bot.use(flowHandlers);
  bot.catch((err) => console.error("Bot error:", err));

  startDigestJob(bot);

  // Dummy HTTP server for Render health checks
  const port = process.env.PORT || 3000;
  createServer((_, res) => {
    res.writeHead(200);
    res.end("OK");
  }).listen(port, () => {
    console.log(`Health check server on port ${port}`);
  });
// Set bot commands menu
  await bot.api.setMyCommands([
    { command: "start", description: "Начать работу с ботом" },
    { command: "add_project", description: "Добавить новый проект" },
    { command: "projects", description: "Список активных проектов" },
    { command: "settings", description: "Настройка времени дайджеста" },
    { command: "digest", description: "Дайджест задач на сегодня" },
    { command: "add_task", description: "Добавить задачи вручную" },
    { command: "tasks", description: "Задачи на человека: /tasks Имя Фамилия" },
    { command: "diag", description: "Диагностика: API, таблицы, окружение" },
  ]);
  console.log(`[boot] node ${process.version}, TZ=${process.env.TZ ?? "unset"}, LLM=${MODEL}, timeout=${TIMEOUT_MS}ms`);
  console.log("🤖 Bot starting...");
  await bot.start();
}

main().catch(console.error);
EOF_src_index_ts_
echo "   ok  src/index.ts"
mkdir -p "."
cat > ".env.example" <<'EOF__env_example_'
DATABASE_URL=postgresql://user:password@localhost:5432/todo_tracker
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
ANTHROPIC_API_KEY=sk-ant-...
# base64 от всего содержимого PEM-ключа сервисного аккаунта (включая BEGIN/END строки)
GOOGLE_PRIVATE_KEY_BASE64=
GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
# необязательные
# LLM_MODEL=claude-fable-5-1
# LLM_TIMEOUT_MS=120000
# TZ=Europe/Nicosia
EOF__env_example_
echo "   ok  .env.example"
echo "-> Проверка типов..."
npx tsc --noEmit && echo "Готово. Дальше: git add -A && git commit -m \"diag_logging\" && git push"
echo
echo "ВНИМАНИЕ: В Render → Environment опционально добавь TZ=Europe/Nicosia (для дайджеста) и LLM_TIMEOUT_MS=120000. После деплоя отправь боту /diag"
