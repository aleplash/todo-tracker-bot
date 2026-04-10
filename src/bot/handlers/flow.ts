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
} from "../../services/gemini";
import { exportTasksToSheet, SheetsAccessError } from "../../services/sheets";
import { projectSelectKeyboard, reviewKeyboard } from "../keyboards";

export const flowHandlers = new Composer<BotContext>();

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

    // Step 1: Generate human-readable MoM with user's prompt
    const momText = await generateMom(text, fileName);

    // Save MoM in session for later export
    const telegramId = BigInt(ctx.from!.id);
    await createSession(telegramId, projectId, momText);

    // Send MoM for review (plain text, not parsed)
    await ctx.editMessageText(momText, {
      reply_markup: reviewKeyboard(),
    });

    await ctx.reply("Если нужны правки — просто отправь мне исправленный текст ответным сообщением.");
  } catch (error) {
    if (error instanceof PdfNoTextError) {
      await ctx.editMessageText(error.message);
    } else if (error instanceof GeminiTimeoutError) {
      await ctx.editMessageText(error.message);
    } else {
      console.error("Flow error:", error);
      await ctx.editMessageText("❌ Произошла ошибка при обработке документа. Попробуйте ещё раз.");
    }
  }
});

// ─── 3. MoM Text Edits ───

flowHandlers.on("message:text", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  const session = await getActiveSession(telegramId);
  if (!session) return;

  // User sent corrected MoM text — save as new draft
  const editedText = ctx.message.text;
  await updateSessionDraft(session.id, editedText);

  await ctx.reply("✅ Правки приняты. Вот обновлённый вариант:\n\n" + editedText, {
    reply_markup: reviewKeyboard(),
  });
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
    if (error instanceof SheetsAccessError) {
      await ctx.reply(error.message);
    } else if (error instanceof GeminiTimeoutError) {
      await ctx.reply("❌ Не удалось извлечь задачи. " + error.message);
    } else {
      console.error("Export error:", error);
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
