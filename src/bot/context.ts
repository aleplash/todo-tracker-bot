import { Context, SessionFlavor } from "grammy";

export interface SessionData {
  /** Waiting for project name + URL input */
  awaitingProject: boolean;
  /** Waiting for notify time input */
  awaitingNotifyTime: boolean;
  /** Temporarily stores PDF buffer while user selects project */
  pdfBuffer: number[] | null;
  /** Original PDF file name (used for MoM title) */
  pdfFileName: string | null;
}

export type BotContext = Context & SessionFlavor<SessionData>;

export function initialSession(): SessionData {
  return {
    awaitingProject: false,
    awaitingNotifyTime: false,
    pdfBuffer: null,
    pdfFileName: null,
  };
}
