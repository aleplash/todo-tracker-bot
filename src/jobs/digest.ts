import cron from "node-cron";
import { Bot } from "grammy";
import { getAllUsers } from "../db";
import { getTodayTasks, type OverdueTask } from "../services/sheets";
import type { BotContext } from "../bot/context";

/**
 * Starts a minutely cron that checks each user's notify_time.
 * When current HH:MM matches, sends a digest of today's tasks.
 */
export function startDigestJob(bot: Bot<BotContext>) {
  // Runs every minute to match user-specific notify times
  cron.schedule("* * * * *", async () => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
      now.getMinutes()
    ).padStart(2, "0")}`;

    try {
      const users = await getAllUsers();

      for (const user of users) {
        if (user.notifyTime !== currentTime) continue;
        if (user.projects.length === 0) continue;

        const allTasks: { project: string; tasks: OverdueTask[] }[] = [];

        for (const project of user.projects) {
          try {
            const tasks = await getTodayTasks(project.spreadsheetId);
            if (tasks.length > 0) {
              allTasks.push({ project: project.projectName, tasks });
            }
          } catch (error) {
            console.error(
              `Digest error for project ${project.projectName}:`,
              error
            );
          }
        }

        if (allTasks.length === 0) continue;

        let msg = "🔔 *Дайджест задач на сегодня:*\n\n";

        for (const { project, tasks } of allTasks) {
          msg += `📁 *${project}*\n`;
          for (const t of tasks) {
            msg += `  • ${t.task} — 👤 ${t.assignee}\n`;
          }
          msg += "\n";
        }

        try {
          await bot.api.sendMessage(Number(user.telegramId), msg, {
            parse_mode: "Markdown",
          });
        } catch (error) {
          console.error(
            `Failed to send digest to ${user.telegramId}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error("Digest cron error:", error);
    }
  });

  console.log("📅 Digest cron job started.");
}
