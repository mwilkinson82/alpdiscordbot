import { describe, expect, it } from "vitest";
import { buildMorningMessage, buildScheduledConversationPrompt, buildWelcomeMessage } from "../src/messages.js";

describe("messages", () => {
  it("builds the requested morning message shape", () => {
    const message = buildMorningMessage(new Date("2026-06-29T12:00:00.000Z"), "America/New_York");
    expect(message).toContain("Good morning");
    expect(message).toContain("Monday, June 29th");
    expect(message).toContain("intentional");
  });

  it("welcomes Contractor Circle members with the member-specific prompt", () => {
    const message = buildWelcomeMessage("123", true);
    expect(message).toContain("<@123>");
    expect(message).toContain("Contractor Circle");
    expect(message).toContain("drop a quick intro");
  });

  it("uses predictable scheduled prompts by daypart", () => {
    expect(buildScheduledConversationPrompt(10).prompt).toContain("most intentional attention");
    expect(buildScheduledConversationPrompt(13).prompt).toContain("Midday check");
    expect(buildScheduledConversationPrompt(16).prompt).toContain("Before the day closes");
  });
});
