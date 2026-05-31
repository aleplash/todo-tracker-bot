import { google, sheets_v4 } from "googleapis";
import { config } from "../config";
import type { GeminiTask, SheetRow } from "../types";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

const SHEET_HEADERS: string[] = [
  "Задача",
  "Ответственный",
  "Дедлайн",
  "Статус",
  "Комментарий",
];

/** Cached auth client */
let sheetsClient: sheets_v4.Sheets | null = null;

/**
 * Returns an authenticated Google Sheets client (singleton).
 */
function getClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.JWT(
    config.google.serviceAccountEmail,
    undefined,
    config.google.privateKey,
    SCOPES
  );

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

/**
 * Extracts spreadsheet ID from a Google Sheets URL.
 * Supports formats:
 *   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit...
 */
export function extractSpreadsheetId(url: string): string | null {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

/**
 * Ensures the sheet has headers in the first row.
 * Idempotent — skips if headers already exist.
 */
async function ensureHeaders(spreadsheetId: string): Promise<void> {
  const client = getClient();

  const existing = await client.spreadsheets.values.get({
    spreadsheetId,
    range: "A1:E1",
  });

  const firstRow = existing.data.values?.[0];
  if (firstRow && firstRow[0] === SHEET_HEADERS[0]) return;

  await client.spreadsheets.values.update({
    spreadsheetId,
    range: "A1:E1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [SHEET_HEADERS] },
  });
}

/**
 * Appends tasks to the Google Sheet linked to a project.
 * Throws SheetsAccessError on 403.
 */
export async function exportTasksToSheet(
  spreadsheetId: string,
  tasks: GeminiTask[]
): Promise<number> {
  const client = getClient();

  try {
    await ensureHeaders(spreadsheetId);

    const rows: SheetRow[] = tasks.map((t) => [
      t.task,
      t.assignee,
      t.deadline,
      false, // Статус: не выполнено
      t.comment,
    ]);

    await client.spreadsheets.values.append({
      spreadsheetId,
      range: "A:E",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });

    return rows.length;
  } catch (error: any) {
    if (error?.code === 403 || error?.status === 403) {
      throw new SheetsAccessError(config.google.serviceAccountEmail);
    }
    throw error;
  }
}

/** Task with a deadline matching today and status = not done */
export interface OverdueTask {
  task: string;
  assignee: string;
  deadline: string;
  isOverdue: boolean;
}

/**
 * Reads all rows from the sheet and returns tasks
 * where deadline == today and status == FALSE / unchecked.
 */
export async function getTodayTasks(
  spreadsheetId: string
): Promise<OverdueTask[]> {
  const client = getClient();

  try {
    const res = await client.spreadsheets.values.get({
      spreadsheetId,
      range: "A2:E", // skip header row
    });

    const rows = res.data.values;
    if (!rows || rows.length === 0) {
      console.log("[Digest] No rows found in sheet");
      return [];
    }

    const today = normalizeDate(formatToday());
    console.log(`[Digest] Today normalized: "${today}", checking ${rows.length} rows`);

    return rows
      .filter((row) => {
        const rawDeadline = row[2]?.trim() ?? "";
        const deadline = normalizeDate(rawDeadline);
        const status = row[3];
        const isDone =
          status === true ||
          status === "TRUE" ||
          status === "Выполнено";
        console.log(`[Digest] Row: "${row[0]}" | deadline raw="${rawDeadline}" normalized="${deadline}" | status="${status}" isDone=${isDone} | match=${deadline === today && !isDone}`);
        return !isDone && (deadline === today || isOverdue(deadline, today));
      })
      .map((row) => {
        const rawDeadline = row[2]?.trim() ?? "";
        const deadline = normalizeDate(rawDeadline);
        const today = normalizeDate(formatToday());
        return {
          task: row[0] ?? "",
          assignee: row[1] ?? "Не назначен",
          deadline: row[2] ?? "",
          isOverdue: isOverdue(deadline, today),
        };
      });
  } catch (error: any) {
    console.error("[Digest] Error reading sheet:", error);
    if (error?.code === 403 || error?.status === 403) {
      throw new SheetsAccessError(config.google.serviceAccountEmail);
    }
    throw error;
  }
}

/**
 * Normalizes various date formats to DD.MM.YYYY for comparison.
 * Handles: DD.MM.YYYY, YYYY-MM-DD, MM/DD/YYYY, D/M/YYYY, serial numbers
 */
function normalizeDate(raw: string): string {
  if (!raw) return "";

  // Already DD.MM.YYYY
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;

  // YYYY-MM-DD (ISO)
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;

  // M/D/YYYY or MM/DD/YYYY
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const m = us[1].padStart(2, "0");
    const d = us[2].padStart(2, "0");
    return `${d}.${m}.${us[3]}`;
  }

  // Google Sheets serial number (days since 30 Dec 1899)
  const num = Number(raw);
  if (!isNaN(num) && num > 40000 && num < 60000) {
    const date = new Date(Date.UTC(1899, 11, 30 + num));
    const d = String(date.getUTCDate()).padStart(2, "0");
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${d}.${m}.${date.getUTCFullYear()}`;
  }

  return raw;
}

/**
 * Returns today's date in DD.MM.YYYY format.
 */
/**
 * Checks if a deadline is in the past (overdue).
 */
function isOverdue(deadline: string, today: string): boolean {
  if (!deadline) return false;
  const [dd, mm, yyyy] = deadline.split(".").map(Number);
  const [td, tm, ty] = today.split(".").map(Number);
  const deadlineDate = new Date(yyyy, mm - 1, dd);
  const todayDate = new Date(ty, tm - 1, td);
  return deadlineDate < todayDate;
}
function formatToday(): string {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const y = now.getFullYear();
  return `${d}.${m}.${y}`;
}

/**
 * Quick connectivity check — tries to read A1.
 * Used when a user adds a new project to validate access.
 */
export async function validateSheetAccess(
  spreadsheetId: string
): Promise<void> {
  const client = getClient();

  try {
    await client.spreadsheets.values.get({
      spreadsheetId,
      range: "A1",
    });
  } catch (error: any) {
    if (error?.code === 403 || error?.status === 403) {
      throw new SheetsAccessError(config.google.serviceAccountEmail);
    }
    if (error?.code === 404 || error?.status === 404) {
      throw new Error("Таблица не найдена. Проверьте ссылку.");
    }
    throw error;
  }
}

export class SheetsAccessError extends Error {
  constructor(serviceEmail: string) {
    super(
      `❌ Нет доступа к таблице. Пожалуйста, выдайте права редактора сервисному email: ${serviceEmail}`
    );
    this.name = "SheetsAccessError";
  }
}
// ============================================================================
//  ДОБАВИТЬ В КОНЕЦ src/services/sheets.ts
//  (использует уже существующие в файле getClient, normalizeDate,
//   SheetsAccessError и config — поэтому это блок для вставки, а не новый файл)
// ============================================================================

/** Полная задача из таблицы (любой дедлайн, любой статус). */
export interface PersonTask {
  task: string;
  assignee: string;
  deadline: string;            // как записано в таблице
  normalizedDeadline: string;  // DD.MM.YYYY (или пусто/как есть, если не дата)
  done: boolean;
  comment: string;
}

/**
 * Читает ВСЕ строки таблицы (без фильтра по сегодняшней дате).
 * В отличие от getTodayTasks возвращает полный набор задач для последующей
 * фильтрации по исполнителю. Пустые строки (без текста задачи) отбрасываются.
 */
export async function getAllTasks(spreadsheetId: string): Promise<PersonTask[]> {
  const client = getClient();

  try {
    const res = await client.spreadsheets.values.get({
      spreadsheetId,
      range: "A2:E", // пропускаем строку заголовков
    });

    const rows = res.data.values ?? [];

    return rows
      .map((row): PersonTask => {
        const status = row[3];
        const done =
          status === true || status === "TRUE" || status === "Выполнено";
        const rawDeadline = (row[2] ?? "").toString().trim();
        return {
          task: (row[0] ?? "").toString(),
          assignee: (row[1] ?? "").toString(),
          deadline: rawDeadline,
          normalizedDeadline: normalizeDate(rawDeadline),
          done,
          comment: (row[4] ?? "").toString(),
        };
      })
      .filter((t) => t.task.trim().length > 0);
  } catch (error: any) {
    if (error?.code === 403 || error?.status === 403) {
      throw new SheetsAccessError(config.google.serviceAccountEmail);
    }
    throw error;
  }
}

