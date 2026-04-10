import { InlineKeyboard } from "grammy";
import type { Project } from "@prisma/client";

/** Builds a project selection keyboard from user's projects */
export function projectSelectKeyboard(projects: Project[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(p.projectName, `select_project:${p.id}`).row();
  }
  return kb;
}

/** Review actions after MoM is generated */
export function reviewKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Отправить в таблицу", "export_tasks")
    .text("❌ Отменить", "cancel_review");
}

/** Project selection for manual task entry */
export function projectSelectKeyboardManual(projects: Project[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of projects) {
    kb.text(p.projectName, `manual_project:${p.id}`).row();
  }
  return kb;
}