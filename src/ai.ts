import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { buildFallbackPrompt } from "./messages.js";
import type { CallRecap, CallRecapInput, ConversationPrompt } from "./types.js";

const recapSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "keyPoints", "discussionQuestion", "suggestedPost"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    keyPoints: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: { type: "string" },
    },
    discussionQuestion: { type: "string" },
    suggestedPost: { type: "string" },
  },
};

const promptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["prompt", "reason"],
  properties: {
    prompt: { type: "string" },
    reason: { type: "string" },
  },
};

export class AiService {
  private readonly client: OpenAI | null;

  constructor(private readonly appConfig: AppConfig) {
    this.client = appConfig.openai.apiKey ? new OpenAI({ apiKey: appConfig.openai.apiKey }) : null;
  }

  available() {
    return Boolean(this.client);
  }

  async generateCallRecap(input: CallRecapInput): Promise<CallRecap> {
    const source = (input.transcript || input.notes || "").trim();
    if (!source) {
      throw new Error("Call recap requires transcript or notes.");
    }

    if (!this.client) {
      logger.warn("OPENAI_API_KEY is missing; returning local fallback recap.");
      return fallbackRecap(input, source);
    }

    const response = await this.client.responses.create({
      model: this.appConfig.openai.model,
      reasoning: { effort: this.appConfig.openai.reasoningEffort } as any,
      text: {
        verbosity: this.appConfig.openai.verbosity,
        format: {
          type: "json_schema",
          name: "contractor_circle_call_recap",
          strict: true,
          schema: recapSchema,
        },
      } as any,
      input: [
        {
          role: "system",
          content: [
            "You write for ALP Contractor Circle, a private operator community for contractors.",
            "Turn messy call notes into a concise Discord post that sounds like Marshall: direct, practical, grounded, and work-focused.",
            "Avoid hype. Avoid generic coaching language. Make members want to reply with specifics from their jobs and businesses.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            title: input.title || "Contractor Circle call",
            speaker: input.speaker || "Marshall",
            source,
          }),
        },
      ],
    });

    return parseJsonResponse<CallRecap>(response.output_text, "call recap");
  }

  async generateConversationPrompt(context: {
    activeUserCount: number;
    recentTopics?: string[];
    dateText: string;
  }): Promise<ConversationPrompt> {
    if (!this.client) {
      return buildFallbackPrompt();
    }

    const response = await this.client.responses.create({
      model: this.appConfig.openai.model,
      reasoning: { effort: this.appConfig.openai.reasoningEffort } as any,
      text: {
        verbosity: this.appConfig.openai.verbosity,
        format: {
          type: "json_schema",
          name: "contractor_circle_conversation_prompt",
          strict: true,
          schema: promptSchema,
        },
      } as any,
      input: [
        {
          role: "system",
          content: [
            "Create one Discord conversation starter for a private contractor operator community.",
            "It should be specific enough to invite useful replies, but not so long that people ignore it.",
            "Focus on operating the business: schedules, estimating, crew handoffs, cash, clients, priorities, leadership, and wins.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(context),
        },
      ],
    });

    return parseJsonResponse<ConversationPrompt>(response.output_text, "conversation prompt");
  }
}

function parseJsonResponse<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    logger.error(`OpenAI returned invalid JSON for ${label}.`, raw);
    throw error;
  }
}

function fallbackRecap(input: CallRecapInput, source: string): CallRecap {
  const sentences = source
    .split(/[.\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
  const title = input.title || "Contractor Circle call";
  return {
    headline: title,
    summary: sentences[0] || "Marshall shared a practical Contractor Circle update and opened the door for members to compare notes.",
    keyPoints: sentences.length ? sentences : ["Review the call notes and pull out the decision, constraint, and next action."],
    discussionQuestion: "What part of this shows up in your business right now?",
    suggestedPost: "",
  };
}
