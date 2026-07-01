import { config as loadEnv } from "dotenv";
import { z } from "zod";
import type { LogLevel } from "./types.js";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

const boolFromEnv = z.preprocess((value) => {
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return value;
}, z.boolean());

const envSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().optional().default(""),
  DISCORD_CLIENT_ID: z.string().optional().default(""),
  DISCORD_GUILD_ID: z.string().min(1).default("927273292354711613"),
  DISCORD_GENERAL_CHANNEL_ID: z.string().min(1).default("1484648401483206739"),
  DISCORD_ANNOUNCEMENTS_CHANNEL_ID: z.string().optional(),
  CONTRACTOR_CIRCLE_ROLE_IDS: z.string().optional().default("1484648318662344985"),
  CONTRACTOR_CIRCLE_ROLE_NAMES: z.string().optional().default("Contractor Circle,Contractor Circle Member,Member"),
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.5"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh"]).default("low"),
  OPENAI_TEXT_VERBOSITY: z.enum(["low", "medium", "high"]).default("low"),
  PORT: z.coerce.number().int().positive().default(8787),
  WEBHOOK_SECRET: z.string().optional().default(""),
  TIMEZONE: z.string().min(1).default("America/New_York"),
  MORNING_POST_HOUR: z.coerce.number().int().min(0).max(23).default(8),
  DAYTIME_PROMPT_HOURS: z.string().optional().default("10,13,16"),
  ENABLE_WEEKEND_POSTS: boolFromEnv.default(false),
  DISCORD_ENABLE_GUILD_MEMBERS_INTENT: boolFromEnv.default(true),
  DISCORD_ENABLE_MESSAGE_CONTENT_INTENT: boolFromEnv.default(false),
  SCHEDULED_PROMPTS_USE_AI: boolFromEnv.default(true),
  ASSISTANT_REPLIES_ENABLED: boolFromEnv.default(true),
  ASSISTANT_REPLY_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(20),
  ASSISTANT_CONTEXTUAL_REPLIES_ENABLED: boolFromEnv.default(true),
  ASSISTANT_CONTEXTUAL_REPLY_WINDOW_MINUTES: z.coerce.number().int().positive().default(180),
  ASSISTANT_CONTEXTUAL_REPLY_MAX_PER_POST: z.coerce.number().int().positive().default(3),
  TARGETED_PROMPT_RESPONSE_HOURS: z.coerce.number().int().positive().default(24),
  DATA_DIR: z.string().min(1).default("./data"),
  WELCOME_DEDUP_MINUTES: z.coerce.number().int().positive().default(5),
  RECENT_ACTIVITY_LOOKBACK_MINUTES: z.coerce.number().int().positive().default(180),
  MIN_MINUTES_BETWEEN_AUTO_PROMPTS: z.coerce.number().int().positive().default(90),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function csv(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hours(value: string) {
  return csv(value)
    .map((item) => Number.parseInt(item, 10))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

const parsed = envSchema.parse(process.env);

export const config = {
  discord: {
    token: parsed.DISCORD_BOT_TOKEN,
    clientId: parsed.DISCORD_CLIENT_ID,
    guildId: parsed.DISCORD_GUILD_ID,
    generalChannelId: parsed.DISCORD_GENERAL_CHANNEL_ID,
    announcementsChannelId: parsed.DISCORD_ANNOUNCEMENTS_CHANNEL_ID || parsed.DISCORD_GENERAL_CHANNEL_ID,
    contractorCircleRoleIds: csv(parsed.CONTRACTOR_CIRCLE_ROLE_IDS),
    contractorCircleRoleNames: csv(parsed.CONTRACTOR_CIRCLE_ROLE_NAMES).map((name) => name.toLowerCase()),
    enableGuildMembersIntent: parsed.DISCORD_ENABLE_GUILD_MEMBERS_INTENT,
    enableMessageContentIntent: parsed.DISCORD_ENABLE_MESSAGE_CONTENT_INTENT,
  },
  openai: {
    apiKey: parsed.OPENAI_API_KEY,
    model: parsed.OPENAI_MODEL,
    reasoningEffort: parsed.OPENAI_REASONING_EFFORT,
    verbosity: parsed.OPENAI_TEXT_VERBOSITY,
  },
  server: {
    port: parsed.PORT,
    webhookSecret: parsed.WEBHOOK_SECRET,
  },
  schedule: {
    timezone: parsed.TIMEZONE,
    morningPostHour: parsed.MORNING_POST_HOUR,
    daytimePromptHours: hours(parsed.DAYTIME_PROMPT_HOURS),
    enableWeekendPosts: parsed.ENABLE_WEEKEND_POSTS,
    useAiScheduledPrompts: parsed.SCHEDULED_PROMPTS_USE_AI,
    recentActivityLookbackMinutes: parsed.RECENT_ACTIVITY_LOOKBACK_MINUTES,
    minMinutesBetweenAutoPrompts: parsed.MIN_MINUTES_BETWEEN_AUTO_PROMPTS,
  },
  assistant: {
    repliesEnabled: parsed.ASSISTANT_REPLIES_ENABLED,
    replyCooldownSeconds: parsed.ASSISTANT_REPLY_COOLDOWN_SECONDS,
    contextualRepliesEnabled: parsed.ASSISTANT_CONTEXTUAL_REPLIES_ENABLED,
    contextualReplyWindowMinutes: parsed.ASSISTANT_CONTEXTUAL_REPLY_WINDOW_MINUTES,
    contextualReplyMaxPerPost: parsed.ASSISTANT_CONTEXTUAL_REPLY_MAX_PER_POST,
    targetedPromptResponseHours: parsed.TARGETED_PROMPT_RESPONSE_HOURS,
  },
  dataDir: parsed.DATA_DIR,
  welcomeDedupMinutes: parsed.WELCOME_DEDUP_MINUTES,
  logLevel: parsed.LOG_LEVEL as LogLevel,
};

export type AppConfig = typeof config;
