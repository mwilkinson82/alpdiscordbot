import type { CallRecap, ConversationPrompt } from "./types.js";
import { formatCommunityDate } from "./dateUtils.js";

const dailyThemes = [
  "work with intentionality",
  "make the important thing visible",
  "protect the schedule before it gets away from you",
  "tighten one loose process",
  "lead the day instead of reacting to it",
];

const promptBank = [
  "What is the one thing on your plate today that needs the most intentional attention?",
  "Where is a job, estimate, or internal handoff starting to feel fuzzy today?",
  "What is one win from the field or office that is worth sharing?",
  "What decision are you trying to make this week that would benefit from another contractor's eyes?",
  "What are you tightening up in the business right now: schedule, estimating, cash, people, or communication?",
  "What is one bottleneck you are seeing repeatedly, and what have you already tried?",
];

export function buildMorningMessage(date: Date, timezone: string) {
  const dateText = formatCommunityDate(date, timezone);
  const theme = dailyThemes[Math.abs(dateText.length + date.getUTCDate()) % dailyThemes.length];
  return `Good morning. It is ${dateText}. Let's have a strong day, work with intentionality, and ${theme}. What is the one thing you need to move forward before the day gets noisy?`;
}

export function buildWelcomeMessage(userId: string, contractorCircleMember: boolean) {
  if (contractorCircleMember) {
    return [
      `Welcome to The Contractor Circle, <@${userId}>.`,
      "",
      "Glad you are here. This is the room for the real operator conversations between calls: wins, bottlenecks, estimates, schedule pressure, hiring, cash, and the decisions that make the business better.",
      "",
      "When you get a minute, drop a quick intro: who you are, what kind of work you do, and what you want to get out of Contractor Circle.",
    ].join("\n");
  }

  return [
    `Welcome, <@${userId}>.`,
    "",
    "Glad you are here. Tell the room who you are, what kind of work you do, and what you are working on this week.",
  ].join("\n");
}

export function buildFallbackPrompt(): ConversationPrompt {
  const prompt = promptBank[Math.floor(Math.random() * promptBank.length)] ?? promptBank[0];
  return {
    prompt,
    reason: "Fallback prompt from the local Contractor Circle prompt bank.",
  };
}

export function buildScheduledConversationPrompt(hour: number): ConversationPrompt {
  if (hour < 12) {
    return {
      prompt: "The morning is almost over. What is the one thing you need to move before 1:00 so the day does not get away from you?",
      reason: "Morning operating-focus prompt.",
    };
  }

  if (hour < 15) {
    return {
      prompt: "Lunch is over. What needs to be handled before 2:00 or 4:00: schedule, crew handoff, estimate, client communication, or cash?",
      reason: "Midday drift-check prompt.",
    };
  }

  return {
    prompt: "Grab a coffee if you need it. What is the one business move that would make the push to 6:00 count?",
    reason: "End-of-day learning prompt.",
  };
}

export function scheduledPromptBrief(hour: number) {
  if (hour < 12) {
    return {
      daypart: "late morning",
      anchor: "The morning is almost over. Push well to 1:00.",
      objective: "Help contractors pick the one business or jobsite priority that must move before lunch.",
    };
  }

  if (hour < 15) {
    return {
      daypart: "after lunch",
      anchor: "Lunch is over. Push to 2:00 or 4:00.",
      objective: "Help contractors regain control of the day and name the operational issue to handle next.",
    };
  }

  return {
    daypart: "late afternoon",
    anchor: "Get a coffee if needed. Push to 6:00.",
    objective: "Help contractors close the day with one useful business move, lesson, or fix.",
  };
}

export function buildPromptPost(prompt: ConversationPrompt) {
  return [
    "Quick check-in for the room:",
    "",
    prompt.prompt,
    "",
    "Drop a sentence or two. The useful stuff is usually in the specifics.",
  ].join("\n");
}

export function buildCallRecapTitle(title: string | undefined, headline: string) {
  const cleanTitle = title?.trim();
  const cleanHeadline = headline.trim();
  if (!cleanTitle) return `Call recap: ${cleanHeadline}`;

  if (/power hour/i.test(cleanTitle)) {
    return `Power Hour recap: ${cleanHeadline}`;
  }

  if (/recap/i.test(cleanTitle)) {
    return `${cleanTitle}: ${cleanHeadline}`;
  }

  return `Call recap: ${cleanTitle}`;
}

export function ensureCallRecapContext(content: string, title: string | undefined, headline: string) {
  const trimmed = content.trim();
  const contextualTitle = buildCallRecapTitle(title, headline);
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? "";

  if (/recap/i.test(firstLine) || firstLine.toLowerCase() === contextualTitle.toLowerCase()) {
    return trimmed;
  }

  return [contextualTitle, "", trimmed].join("\n");
}

export function buildCallRecapPost(recap: CallRecap) {
  const keyPoints = recap.keyPoints.slice(0, 4).map((point) => `- ${point}`).join("\n");
  return [
    `Call recap: ${recap.headline}`,
    "",
    recap.summary,
    "",
    keyPoints ? `Key points:\n${keyPoints}` : "",
    "",
    `Question for the room: ${recap.discussionQuestion}`,
  ]
    .filter(Boolean)
    .join("\n");
}
