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
