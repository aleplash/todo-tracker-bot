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
<<<<<<< Updated upstream
    model: "claude-fable-5-1",
=======
    model: MODEL,
>>>>>>> Stashed changes
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

