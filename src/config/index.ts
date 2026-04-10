import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env variable: ${name}`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  google: {
    serviceAccountEmail: required("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    privateKey: required("GOOGLE_PRIVATE_KEY"),
  },
} as const;
