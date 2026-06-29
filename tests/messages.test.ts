import { describe, expect, it } from "vitest";
import {
  buildMorningMessage,
  buildScheduledConversationPrompt,
  buildWelcomeMessage,
  ensureCallRecapContext,
} from "../src/messages.js";

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
    expect(buildScheduledConversationPrompt(10).prompt).toContain("before 1:00");
    expect(buildScheduledConversationPrompt(13).prompt).toContain("before 2:00 or 4:00");
    expect(buildScheduledConversationPrompt(16).prompt).toContain("push to 6:00");
  });

  it("keeps call recap context even when AI omits it", () => {
    const message = ensureCallRecapContext(
      "Default is expensive.\n\nThis week's filter is simple.",
      "Monday Power Hour: Default Is Expensive",
      "Default Is Expensive",
    );
    expect(message.startsWith("Power Hour recap: Default Is Expensive")).toBe(true);
  });
});
