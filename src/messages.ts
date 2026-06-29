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

export function buildPromptPost(prompt: ConversationPrompt) {
  return [
    "Quick check-in for the room:",
    "",
    prompt.prompt,
    "",
    "Drop a sentence or two. The useful stuff is usually in the specifics.",
  ].join("\n");
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
