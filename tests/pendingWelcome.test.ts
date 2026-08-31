import { describe, expect, it } from "vitest";
import { deriveWatchKeywords } from "../src/pendingWelcome.js";

describe("deriveWatchKeywords", () => {
  it("builds username and display-name fragments from name and email", () => {
    const keywords = deriveWatchKeywords("Andrew Ernst", "a.ernst@acernst.com");
    expect(keywords).toEqual(expect.arrayContaining(["Andrew", "Ernst", "andrewernst", "aernst", "acernst"]));
  });
});
