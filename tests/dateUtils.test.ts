import { describe, expect, it } from "vitest";
import { formatCommunityDate, ordinal } from "../src/dateUtils.js";

describe("date utils", () => {
  it("formats ordinal days", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
    expect(ordinal(21)).toBe("21st");
  });

  it("formats the morning date in the configured timezone", () => {
    const date = new Date("2026-06-29T12:00:00.000Z");
    expect(formatCommunityDate(date, "America/New_York")).toBe("Monday, June 29th");
  });
});
