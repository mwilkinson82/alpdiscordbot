import { ActivityStore } from "./activityStore.js";
import { AiService } from "./ai.js";
import { config } from "./config.js";
import { ContractorCircleBot } from "./discord.js";
import { configureLogger, logger } from "./logger.js";
import { startScheduler } from "./scheduler.js";
import { startHttpServer } from "./server.js";

configureLogger(config.logLevel);

const store = new ActivityStore(config.dataDir);
await store.load();

const ai = new AiService(config);
const bot = new ContractorCircleBot(config, store, ai);

const stopHttp = startHttpServer(config, bot, store);
let stopScheduler: (() => void) | undefined;

try {
  const discordStarted = await bot.start();
  if (discordStarted) {
    stopScheduler = startScheduler(config, bot, store);
  }
  logger.info("ALP Discord bot is running.", {
    aiEnabled: ai.available(),
    discordStarted,
    guildId: config.discord.guildId,
  });
} catch (error: any) {
  logger.error("Bot startup failed.", error?.message);
  stopHttp();
  process.exitCode = 1;
}

async function shutdown(signal: string) {
  logger.info(`Received ${signal}; shutting down.`);
  stopScheduler?.();
  stopHttp();
  await bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
