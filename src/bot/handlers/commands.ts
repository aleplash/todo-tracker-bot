import { Composer } from "grammy";
import type { BotContext } from "../context";
import {
  findOrCreateUser,
  getUserProjects,
  addProject,
  updateNotifyTime,
} from "../../db";
import { extractSpreadsheetId, validateSheetAccess } from "../../services/sheets";

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
