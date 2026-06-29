import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import { buildFallbackPrompt, buildScheduledConversationPrompt, scheduledPromptBrief } from "./messages.js";
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

  async generateScheduledConversationPrompt(context: {
    hour: number;
    activeUserCount: number;
    dateText: string;
  }): Promise<ConversationPrompt> {
    const brief = scheduledPromptBrief(context.hour);
    const fallback = buildScheduledConversationPrompt(context.hour);

    if (!this.client) {
      return fallback;
    }

    try {
      const response = await this.client.responses.create({
        model: this.appConfig.openai.model,
        reasoning: { effort: this.appConfig.openai.reasoningEffort } as any,
        text: {
          verbosity: this.appConfig.openai.verbosity,
          format: {
            type: "json_schema",
            name: "contractor_circle_scheduled_prompt",
            strict: true,
            schema: promptSchema,
          },
        } as any,
        input: [
          {
            role: "system",
            content: [
              "Create one short scheduled Discord prompt for ALP Contractor Circle.",
              "The goal is to help contractors have a great day by pushing the next work block with intention.",
              "Keep it practical, business-focused, direct, and human. No hype, no generic motivation, no long coaching paragraph.",
              "Use the time-block anchor, but vary the wording day to day.",
              "Good topics: schedule, crew handoff, estimating, client communication, cash, leadership, priorities, jobsite follow-through, one next action.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              ...context,
              ...brief,
              fallbackPrompt: fallback.prompt,
            }),
          },
        ],
      });

      return parseJsonResponse<ConversationPrompt>(response.output_text, "scheduled conversation prompt");
    } catch (error: any) {
      logger.warn("AI scheduled prompt failed; using fixed fallback.", error?.message);
      return fallback;
    }
  }

  async generateAssistantReply(context: {
    message: string;
    authorName: string;
    channelName?: string;
    referencedBotMessage?: string;
  }): Promise<string> {
    const message = context.message.trim();
    if (!message) {
      return "I saw the reply, but I need a little more to go on. Ask me a specific question or use `/ask` and I’ll help.";
    }

    if (!this.client) {
      return fallbackAssistantReply(message);
    }

    const response = await this.client.responses.create({
      model: this.appConfig.openai.model,
      reasoning: { effort: this.appConfig.openai.reasoningEffort } as any,
      text: { verbosity: this.appConfig.openai.verbosity } as any,
      max_output_tokens: 320,
      input: [
        {
          role: "system",
          content: [
            "You are ALP Think, the ALP Contractor Circle Discord assistant.",
            "You are not Marshall. Do not claim to be Marshall.",
            "Help contractors think like owners using the Contractor Circle operating lens and the ALP manner: direct, practical, accountable, high-standard, and bottom-line focused.",
            "AOS is ALP's version of EOS, the Entrepreneurial Operating System. Treat it as the operating discipline for vision, people, data, issues, process, traction, accountability, and weekly execution rhythm.",
            "IOR is the project-control methodology used in the Contractor Circle context. Discuss it through a practical construction lens: current project reality, risks, exposures, owner/client decisions, schedule, change orders, lessons learned, implementation going forward, and bottom-line impact.",
            "Be brief, practical, and direct. Ask a useful follow-up when the member gives a short phrase.",
            "Focus on business execution, strategy, estimating, scheduling, cash, risk, capacity, leadership, client communication, and staying out of default mode.",
            "Do not invent specific Contractor Circle source material. If the question requires the private knowledge base, say you can help generally now and that the deeper Ask Marshall library is coming.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify(context),
        },
      ],
    });

    return cleanAssistantReply(response.output_text);
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

function fallbackAssistantReply(message: string) {
  if (message.length < 30) {
    return `Good. Make it specific: what part of "${message}" are you trying to improve today, and what would count as progress by the end of the day?`;
  }

  return "Good question. Start with the owner filter: does this make money, reduce risk, or create capacity? If it does, name the next action. If it does not, cut it, delegate it, delay it, simplify it, or systemize it.";
}

function cleanAssistantReply(reply: string) {
  const trimmed = reply.trim();
  if (trimmed.length <= 1800) return trimmed;
  return `${trimmed.slice(0, 1790).trimEnd()}...`;
}
