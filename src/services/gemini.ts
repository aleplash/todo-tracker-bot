import { config } from "../config";
import type { GeminiTask } from "../types";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 60_000;

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
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
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
          body: JSON.stringify(body),
        },
        TIMEOUT_MS
      );

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Claude API error ${response.status}: ${errorBody}`);
      }

      const data: any = await response.json();
      const textBlock = data?.content?.find((b: any) => b.type === "text");
      return textBlock?.text ?? "";
    } catch (error) {
      lastError = error as Error;
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }

  throw new GeminiTimeoutError(lastError?.message);
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

export class GeminiTimeoutError extends Error {
  constructor(detail?: string) {
    super(`Не удалось получить ответ после ${MAX_RETRIES} попыток.${detail ? ` Причина: ${detail}` : ""}`);
    this.name = "GeminiTimeoutError";
  }
}
// ============================================================================
//  ДОБАВИТЬ В src/services/gemini.ts
//  (нужно только если используете опциональный resolveAliasesWithClaude
//   из people.ts; использует приватную callClaude, поэтому живёт здесь)
// ============================================================================

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

