import { Bot, session } from "grammy";
import { config } from "./config";
import { type BotContext, initialSession } from "./bot/context";
import { commandHandlers } from "./bot/handlers/commands";
import { flowHandlers } from "./bot/handlers/flow";
import { startDigestJob } from "./jobs/digest";
import { createServer } from "http";

async function main() {
  const bot = new Bot<BotContext>(config.telegramBotToken);

  bot.use(session({ initial: initialSession }));
  bot.use(commandHandlers);
  bot.use(flowHandlers);
  bot.catch((err) => console.error("Bot error:", err));

  startDigestJob(bot);

  // Dummy HTTP server for Render health checks
  const port = process.env.PORT || 3000;
  createServer((_, res) => {
    res.writeHead(200);
    res.end("OK");
  }).listen(port, () => {
    console.log(`Health check server on port ${port}`);
  });

  console.log("🤖 Bot starting...");
  await bot.start();
}

main().catch(console.error);