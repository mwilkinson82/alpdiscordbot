import express from "express";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ContractorCircleBot } from "./discord.js";
import { logger } from "./logger.js";

const callRecapSchema = z.object({
  title: z.string().optional(),
  speaker: z.string().optional(),
  transcript: z.string().optional(),
  notes: z.string().optional(),
  channelId: z.string().optional(),
});

const targetedPromptSchema = z.object({
  targetUserId: z.string().min(1),
  targetName: z.string().min(1),
  content: z.string().min(1),
  channelId: z.string().optional(),
});

const quizSchema = z.object({
  topic: z.string().optional(),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  channelId: z.string().optional(),
});

export function startHttpServer(appConfig: AppConfig, bot: ContractorCircleBot) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "alpdiscordbot" });
  });

  app.post("/webhooks/call-recap", async (req, res) => {
    if (!isAuthorized(appConfig, req.header("x-webhook-secret"))) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const parsed = callRecapSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }

    if (!parsed.data.transcript && !parsed.data.notes) {
      res.status(400).json({ ok: false, error: "transcript or notes is required" });
      return;
    }

    try {
      const result = await bot.postCallRecap(parsed.data);
      res.json({
        ok: true,
        messageId: result.message.id,
        channelId: result.message.channelId,
        recap: result.recap,
      });
    } catch (error: any) {
      logger.error("Call recap webhook failed.", error?.message);
      res.status(500).json({ ok: false, error: "Call recap failed" });
    }
  });

  app.post("/webhooks/targeted-prompt", async (req, res) => {
    if (!isAuthorized(appConfig, req.header("x-webhook-secret"))) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const parsed = targetedPromptSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }

    try {
      const channelId = parsed.data.channelId || appConfig.discord.generalChannelId;
      const message = await bot.postRawMessage(channelId, parsed.data.content, [parsed.data.targetUserId]);
      await bot.recordTargetedPrompt({
        targetUserId: parsed.data.targetUserId,
        targetName: parsed.data.targetName,
        channelId,
        messageId: message.id,
        promptText: parsed.data.content,
      });
      res.json({ ok: true, messageId: message.id, channelId: message.channelId });
    } catch (error: any) {
      logger.error("Targeted prompt webhook failed.", error?.message);
      res.status(500).json({ ok: false, error: "Targeted prompt failed" });
    }
  });

  app.post("/webhooks/quiz", async (req, res) => {
    if (!isAuthorized(appConfig, req.header("x-webhook-secret"))) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const parsed = quizSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }

    try {
      const result = await bot.postQuiz(parsed.data);
      res.json({
        ok: true,
        quizId: result.quiz.id,
        messageId: result.message.id,
        channelId: result.message.channelId,
      });
    } catch (error: any) {
      logger.error("Quiz webhook failed.", error?.message);
      res.status(500).json({ ok: false, error: "Quiz failed" });
    }
  });

  const server = app.listen(appConfig.server.port, () => {
    logger.info(`HTTP server listening on port ${appConfig.server.port}.`);
  });

  return () => server.close();
}

function isAuthorized(appConfig: AppConfig, providedSecret?: string) {
  if (!appConfig.server.webhookSecret) {
    return process.env.NODE_ENV !== "production";
  }
  return providedSecret === appConfig.server.webhookSecret;
}
