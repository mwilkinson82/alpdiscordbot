import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityStore } from "../src/activityStore.js";
import { deriveWatchKeywords, watchContractorCircleMember } from "../src/pendingWelcome.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("deriveWatchKeywords", () => {
  it("builds username and display-name fragments from name and custom-domain email", () => {
    const keywords = deriveWatchKeywords("Andrew Ernst", "a.ernst@acernst.com");
    expect(keywords).toEqual(expect.arrayContaining(["Andrew", "Ernst", "andrewernst", "aernst", "acernst"]));
    expect(keywords.map((keyword) => keyword.toLowerCase())).not.toEqual(expect.arrayContaining(["com", "gmail"]));
  });

  it("does not use public email domains or TLDs as match keywords", () => {
    const keywords = deriveWatchKeywords("Rachel Stone", "rachel@gmail.com");
    expect(keywords.map((keyword) => keyword.toLowerCase())).toEqual(expect.arrayContaining(["rachel", "stone"]));
    expect(keywords.map((keyword) => keyword.toLowerCase())).not.toContain("gmail");
    expect(keywords.map((keyword) => keyword.toLowerCase())).not.toContain("com");
  });
});

describe("pending welcome email keyword denylist", () => {
  it("matches rachel@gmail.com on name and local-part, not on gmail or com", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alpdiscordbot-keywords-"));
    dirs.push(dir);
    const store = new ActivityStore(dir);
    const pending = await watchContractorCircleMember(store, {
      expectedName: "Rachel Stone",
      email: "rachel@gmail.com",
    });

    expect(pending.keywords).toEqual(expect.arrayContaining(["rachel", "stone"]));
    expect(pending.keywords).not.toContain("gmail");
    expect(pending.keywords).not.toContain("com");
    expect(pending.keywords.some((keyword) => keyword === "gmail" || keyword === "com" || keyword.includes(" gmail "))).toBe(false);

    expect(
      await store.pendingWelcomeForMember({
        username: "rachel",
        displayName: "Rachel Stone",
      }),
    ).toMatchObject({ id: pending.id });

    expect(
      await store.pendingWelcomeForMember({
        username: "gmail",
        displayName: "gmail",
      }),
    ).toBeUndefined();

    expect(
      await store.pendingWelcomeForMember({
        username: "comfort",
        displayName: "Company",
      }),
    ).toBeUndefined();
  });
});
