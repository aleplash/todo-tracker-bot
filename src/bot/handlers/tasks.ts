// src/bot/handlers/tasks.ts
//
// «Выписать все задачи на человека» по всем проектам — для любого исполнителя.
// Плюс /people — показать, как бот сгруппировал имена (для проверки кластеризации).
//
// Триггеры:
//   /tasks Александр Николаев
//   "выпиши все задачи на Сашу Николаева"
//   /people
//
// Регистрировать в index.ts МЕЖДУ commandHandlers и flowHandlers.

import { Composer } from "grammy";
import type { BotContext } from "../context";
import { getUserProjects } from "../../db";
import { getAllTasks, type PersonTask } from "../../services/sheets";
import {
  getClusters,
  findClusters,
  buildMembershipMap,
  type PersonCluster,
} from "../../services/person-resolver";
import { membershipKey } from "../../services/people";

export const tasksHandlers = new Composer<BotContext>();

const NL_TRIGGER =
  /^\s*(?:выпиши|покажи|собери|дай|список)?\s*(?:все\s+)?задачи\s+(?:на|по|для)\s+(.+)$/i;

const MAX_MESSAGE = 3500;

// ─── /tasks ───

tasksHandlers.command("tasks", async (ctx) => {
  const name = ctx.match?.trim();
  if (!name) {
    await ctx.reply("Использование: /tasks Имя Фамилия\nНапример: /tasks Александр Николаев");
    return;
  }
  await runTasksQuery(ctx, name);
});

tasksHandlers.hears(NL_TRIGGER, async (ctx) => {
  const name = ctx.match[1]?.trim();
  if (name) await runTasksQuery(ctx, name);
});

// ─── /people — как бот сгруппировал имена ───

tasksHandlers.command("people", async (ctx) => {
  const telegramId = BigInt(ctx.from!.id);
  const workspaceKey = String(telegramId);
  const projects = await getUserProjects(telegramId);

  if (projects.length === 0) {
    await ctx.reply("У вас нет проектов. Добавьте через /add_project");
    return;
  }

  await ctx.reply("⏳ Собираю список людей…");

  const distinctAssignees = await collectAssignees(projects);
  if (distinctAssignees.length === 0) {
    await ctx.reply("В таблицах пока нет исполнителей.");
    return;
  }

  const clusters = await getClusters(workspaceKey, distinctAssignees);
  const sorted = [...clusters].sort((a, b) =>
    a.canonical.localeCompare(b.canonical, "ru")
  );

  const blocks: string[] = [`👥 Распознано людей: ${sorted.length}\n`];
  for (const c of sorted) {
    const others = c.variants.filter(
      (v) => v.trim().toLowerCase() !== c.canonical.trim().toLowerCase()
    );
    let block = `👤 ${c.canonical}`;
    if (others.length > 0) block += `\n   варианты: ${others.join(", ")}`;
    blocks.push(block + "\n");
  }

  for (const chunk of packBlocks(blocks)) await ctx.reply(chunk);
});

// ─── Основная логика /tasks ───

async function runTasksQuery(ctx: BotContext, name: string): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const workspaceKey = String(telegramId);
  const projects = await getUserProjects(telegramId);

  if (projects.length === 0) {
    await ctx.reply("У вас нет проектов. Добавьте через /add_project");
    return;
  }

  await ctx.reply(`⏳ Ищу задачи: ${name}…`);

  // 1. Читаем все строки всех проектов.
  const perProject: { project: string; tasks: PersonTask[] }[] = [];
  const distinctAssignees: string[] = [];

  for (const project of projects) {
    try {
      const all = await getAllTasks(project.spreadsheetId);
      perProject.push({ project: project.projectName, tasks: all });
      for (const t of all) if (t.assignee.trim()) distinctAssignees.push(t.assignee);
    } catch (error) {
      console.error(`[tasks] project ${project.projectName}:`, error);
    }
  }

  // 2. Кластеры людей (LLM один раз, дальше кеш).
  const clusters = await getClusters(workspaceKey, distinctAssignees);

  // 3. Резолвим запрос → кластер.
  const matched = findClusters(clusters, name);

  if (matched.length === 0) {
    await ctx.reply(`Не нашёл человека по запросу «${name}».`);
    return;
  }
  if (matched.length > 1) {
    const list = matched.map((c, i) => `${i + 1}. ${c.canonical}`).join("\n");
    await ctx.reply(
      `Нашёл несколько подходящих людей:\n${list}\n\nУточните фамилию.`
    );
    return;
  }

  const target = matched[0];

  // 4. Точная фильтрация по принадлежности строки кластеру.
  const membership = buildMembershipMap(clusters, distinctAssignees);
  const today = todayDMY();
  const grouped: { project: string; tasks: PersonTask[] }[] = [];

  for (const { project, tasks } of perProject) {
    const mine = tasks.filter(
      (t) => !t.done && membership.get(membershipKey(t.assignee)) === target.canonical
    );
    if (mine.length > 0) {
      mine.sort((a, b) => sortKey(a) - sortKey(b));
      grouped.push({ project, tasks: mine });
    }
  }

  if (grouped.length === 0) {
    await ctx.reply(`У «${target.canonical}» нет активных задач.`);
    return;
  }

  const total = grouped.reduce((n, g) => n + g.tasks.length, 0);
  for (const chunk of formatGrouped(target.canonical, total, grouped, today)) {
    await ctx.reply(chunk);
  }
}

// ─── Сбор уникальных исполнителей ───

async function collectAssignees(
  projects: { projectName: string; spreadsheetId: string }[]
): Promise<string[]> {
  const out: string[] = [];
  for (const project of projects) {
    try {
      const all = await getAllTasks(project.spreadsheetId);
      for (const t of all) if (t.assignee.trim()) out.push(t.assignee);
    } catch (error) {
      console.error(`[people] project ${project.projectName}:`, error);
    }
  }
  return out;
}

// ─── Форматирование (как во вложении) ───

function formatGrouped(
  name: string,
  total: number,
  grouped: { project: string; tasks: PersonTask[] }[],
  today: string
): string[] {
  const blocks: string[] = [`📋 Задачи: ${name} — всего ${total}`];

  for (const { project, tasks } of grouped) {
    let block = `\n📁 ${project}\n`;
    for (const t of tasks) {
      const { label, date } = statusLabel(t, today);
      const stamp = date ? ` (${date})` : "";
      block += `• ${label}${stamp}: ${t.task}`;
      if (t.comment.trim()) block += ` — ${t.comment.trim()}`;
      block += "\n";
    }
    blocks.push(block);
  }

  return packBlocks(blocks);
}

/** Склеивает блоки в сообщения с учётом лимита Telegram. */
function packBlocks(blocks: string[]): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const block of blocks) {
    if (buf.length + block.length > MAX_MESSAGE && buf) {
      chunks.push(buf.trimEnd());
      buf = "";
    }
    buf += block;
  }
  if (buf.trim()) chunks.push(buf.trimEnd());
  return chunks;
}

function statusLabel(t: PersonTask, today: string): { label: string; date: string } {
  const d = t.normalizedDeadline;
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(d)) {
    return { label: "БЕЗ ДЕДЛАЙНА", date: t.deadline || "" };
  }
  return cmpDMY(d, today) < 0
    ? { label: "ПРОСРОЧЕНО", date: d }
    : { label: "В ПЛАНЕ", date: d };
}

// ─── Даты ───

function todayDMY(): string {
  const n = new Date();
  const dd = String(n.getDate()).padStart(2, "0");
  const mm = String(n.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${n.getFullYear()}`;
}

function sortKey(t: PersonTask): number {
  const d = t.normalizedDeadline;
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(d)) return Number.MAX_SAFE_INTEGER;
  return dmyToNum(d);
}

function cmpDMY(a: string, b: string): number {
  return dmyToNum(a) - dmyToNum(b);
}

function dmyToNum(d: string): number {
  const [dd, mm, yyyy] = d.split(".");
  return Number(yyyy) * 10000 + Number(mm) * 100 + Number(dd);
}

