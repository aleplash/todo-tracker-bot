#!/usr/bin/env bash
set -euo pipefail
# apply_short_mom.sh — запускать из КОРНЯ репозитория todo-tracker-bot:
#   bash apply_short_mom.sh
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
export const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 300_000;
/** Лимит длины ответа для MoM. Кириллица ≈ 2 символа/токен, длинная встреча — 10–20k токенов. */
const MOM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) || 16_384;
/** Лимит для JSON-извлечения задач (десятки задач помещаются с запасом). */
const TASKS_MAX_TOKENS = 8_192;
/** Модель. Переопределяется env LLM_MODEL. */
export const MODEL = process.env.LLM_MODEL || "claude-fable-5-1";
/** Статусы, при которых повтор бессмысленен (ключ, модель, формат запроса). */
const NON_RETRYABLE = new Set([400, 401, 403, 404, 413]);

// ─── Промт 1: Генерация MoM ───

function buildMomPrompt(fileName: string): string {
  const today = formatDate(new Date());
  const nextWeek = formatDate(addDays(new Date(), 7));
  const title = fileName.replace(/\.pdf$/i, "").replace(/транскрипция/gi, "").trim() || "Встреча";

  return `Ты составляешь короткие минутки рабочей встречи по транскрипции. Только факты из транскрипции, ничего не выдумывай и не добавляй от себя.

Название встречи: "${title}". Дата встречи: ${today}.

ФОРМАТ ОТВЕТА — строго такой, без единого лишнего элемента:

MN "${title}" от ${today}

Договорённости:
- <одно принятое решение, одной строкой, до 15 слов>
- <ещё решение>

Задачи и DDL:
@Ответственный (Команда/Роль): описание задачи DDL ДД.ММ.ГГГГ.
@Ответственный (Команда/Роль): описание задачи DDL ДД.ММ.ГГГГ.

ПРАВИЛА:
- Обычный текст. Никакого markdown: не используй **, __, #, \`, > и подобные символы разметки.
- Не перечисляй участников встречи, не пиши вступление, итоги, благодарности, дисклеймеры.
- Не ставь ссылки на транскрипцию, таймкоды и номера реплик.
- В «Договорённости» — только принятые решения и зафиксированные факты, без пересказа хода обсуждения, аргументов и вариантов. Не больше 10 пунктов, каждый — одна короткая строка.
- В «Задачи и DDL» — только конкретные поручения с исполнителем. Описание задачи — до 20 слов.
- DDL: если срок назвали на встрече — используй его («до конца недели» = ближайшая пятница, «завтра» = ${formatDate(addDays(new Date(), 1))}); если не назвали — ставь ${nextWeek}.
- Если задач нет — напиши в разделе одну строку: «Задач не зафиксировано».`;
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
  const { text, truncated } = await callClaudeRaw(
    systemPrompt,
    `Вот транскрипция встречи:\n\n${transcriptionText}`,
    MOM_MAX_TOKENS
  );
  const clean = stripMarkdown(text);
  if (truncated) {
    console.warn(`[claude] MoM truncated at ${MOM_MAX_TOKENS} tokens`);
    return clean + `\n\n⚠️ Текст обрезан: ответ упёрся в лимит ${MOM_MAX_TOKENS} токенов. Можно поднять LLM_MAX_TOKENS в настройках Render или разбить транскрипцию.`;
  }
  return clean;
}

/** Убирает markdown-разметку, которую модель иногда вставляет вопреки промту. */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")   // **жирный**
    .replace(/__(.+?)__/g, "$1")         // __жирный__
    .replace(/\*(\S[^*\n]*?\S|\S)\*/g, "$1") // *курсив*
    .replace(/^#{1,6}\s+/gm, "")          // # заголовки
    .replace(/^\s*[*•]\s+/gm, "- ")      // маркеры списков → "- "
    .replace(/\n{3,}/g, "\n\n")          // лишние пустые строки
    .trim();
}

export async function extractTasksFromMom(momText: string): Promise<GeminiTask[]> {
  const { text, truncated } = await callClaudeRaw(EXTRACT_TASKS_PROMPT, momText, TASKS_MAX_TOKENS);
  if (truncated) {
    throw new Error(`Список задач слишком длинный: JSON обрезан на ${TASKS_MAX_TOKENS} токенах.`);
  }
  return parseTasksJson(text);
}

// ─── Claude API call with retry ───

interface ClaudeResult {
  text: string;
  /** stop_reason === "max_tokens": ответ не дописан. */
  truncated: boolean;
}

async function callClaude(systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
  return (await callClaudeRaw(systemPrompt, userMessage, maxTokens)).text;
}

async function callClaudeRaw(systemPrompt: string, userMessage: string, maxTokens: number): Promise<ClaudeResult> {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };
  const inputChars = systemPrompt.length + userMessage.length;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const started = Date.now();
    try {
      console.log(`[claude] attempt ${attempt}/${MAX_RETRIES} model=${MODEL} input=${inputChars} chars max_tokens=${maxTokens} timeout=${TIMEOUT_MS}ms`);
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
      return { text: textBlock?.text ?? "", truncated: data?.stop_reason === "max_tokens" };
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
# LLM_TIMEOUT_MS=300000
# LLM_MAX_TOKENS=16384
# TZ=Europe/Nicosia
EOF__env_example_
echo "   ok  .env.example"
echo "-> Проверка типов..."
npx tsc --noEmit && echo "Готово. Дальше: git add -A && git commit -m \"short_mom\" && git push"
