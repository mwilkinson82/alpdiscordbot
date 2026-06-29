import cron from "node-cron";
import type { ContractorCircleBot } from "./discord.js";
import type { AppConfig } from "./config.js";
import { isWeekend } from "./dateUtils.js";
import { logger } from "./logger.js";
import type { ActivityStore } from "./activityStore.js";

export function startScheduler(appConfig: AppConfig, bot: ContractorCircleBot, store: ActivityStore) {
  const tasks: Array<ReturnType<typeof cron.schedule>> = [];

  const morningExpression = `0 ${appConfig.schedule.morningPostHour} * * *`;
  tasks.push(
    cron.schedule(
      morningExpression,
      () => {
        void guarded("morning message", appConfig, () => bot.postMorningMessage());
      },
      { timezone: appConfig.schedule.timezone },
    ),
  );

  for (const hour of appConfig.schedule.daytimePromptHours) {
    tasks.push(
      cron.schedule(
        `0 ${hour} * * *`,
        () => {
          void guarded("conversation prompt", appConfig, async () => {
            const lastPrompt = await store.lastPostAt("prompt");
            if (lastPrompt) {
              const minutesSinceLast = (Date.now() - lastPrompt.getTime()) / 60000;
              if (minutesSinceLast < appConfig.schedule.minMinutesBetweenAutoPrompts) {
                logger.info("Skipping scheduled prompt because the last prompt was recent.");
                return;
              }
            }
            await bot.postConversationPrompt(undefined, hour);
          });
        },
        { timezone: appConfig.schedule.timezone },
      ),
    );
  }

  logger.info("Scheduler started.", {
    morningExpression,
    daytimePromptHours: appConfig.schedule.daytimePromptHours,
    timezone: appConfig.schedule.timezone,
  });

  return () => {
    for (const task of tasks) task.stop();
  };
}

async function guarded(label: string, appConfig: AppConfig, fn: () => Promise<unknown>) {
  if (!appConfig.schedule.enableWeekendPosts && isWeekend(new Date(), appConfig.schedule.timezone)) {
    logger.info(`Skipping ${label} on weekend.`);
    return;
  }

  try {
    await fn();
    logger.info(`Scheduled ${label} completed.`);
  } catch (error: any) {
    logger.error(`Scheduled ${label} failed.`, error?.message);
  }
}
