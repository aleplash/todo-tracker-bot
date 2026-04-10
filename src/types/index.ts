/** Task extracted by Gemini from a meeting transcription */
export interface GeminiTask {
  task: string;
  assignee: string;
  deadline: string; // DD.MM.YYYY
  comment: string;
}

/** Row to be appended to Google Sheets (columns A–E) */
export type SheetRow = [
  string,  // A: Задача
  string,  // B: Ответственный
  string,  // C: Дедлайн (DD.MM.YYYY)
  boolean, // D: Статус (FALSE = не выполнено)
  string,  // E: Комментарий
];

/** Session statuses */
export type SessionStatus = "pending_review" | "approved" | "exported";
