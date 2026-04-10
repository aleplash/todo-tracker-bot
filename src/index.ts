import { Bot, session } from "grammy";
import { config } from "./config";
import { type BotContext, initialSession } from "./bot/context";
import { commandHandlers } from "./bot/handlers/commands";
import { flowHandlers } from "./bot/handlers/flow";
import { startDigestJob } from "./jobs/digest";

async function main() {
  const bot = new Bot<BotContext>(config.telegramBotToken);

  // Session middleware (in-memory, resets on restart)
  bot.use(
    session({
      initial: initialSession,
    })
  );

  // Register handlers (order matters: commands first, then flow)
  bot.use(commandHandlers);
  bot.use(flowHandlers);

  // Error handler
  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  // Start digest cron
  startDigestJob(bot);

  // Launch
  console.log("🤖 Bot starting...");
  await bot.start();
}

main().catch(console.error);
