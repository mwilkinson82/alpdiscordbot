import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityStore } from "../src/activityStore.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "alpdiscordbot-"));
  dirs.push(dir);
  const store = new ActivityStore(dir);
  await store.load();
  return store;
}

describe("ActivityStore quiz and activity tracking", () => {
  it("records quiz attempts and leaderboard points", async () => {
    const store = await makeStore();
    const quiz = await store.recordQuiz({
      id: "quiz-1",
      channelId: "channel-1",
      topic: "IOR",
      question: "What should IOR surface first?",
      choices: ["Risk and money", "Busy work", "Random tasks", "Color coding"],
      correctIndex: 0,
      explanation: "IOR should expose project risk and bottom-line impact.",
      ttlHours: 1,
    });

    const result = await store.recordQuizAttempt({
      quizId: quiz.id,
      userId: "user-1",
      username: "caleb",
      displayName: "Caleb",
      choiceIndex: 0,
    });

    expect(result.alreadyAnswered).toBe(false);
    expect(result.attempt.correct).toBe(true);

    const leaderboard = await store.quizLeaderboard("week");
    expect(leaderboard[0]).toMatchObject({
      displayName: "Caleb",
      points: 1,
      correct: 1,
      attempts: 1,
    });
  });

  it("estimates active time from member activity events", async () => {
    const store = await makeStore();
    const now = new Date();
    await store.recordMessage({
      userId: "user-1",
      username: "caleb",
      displayName: "Caleb",
      at: new Date(now.getTime() - 7 * 60 * 1000),
    });
    await store.recordMessage({
      userId: "user-1",
      username: "caleb",
      displayName: "Caleb",
      at: now,
    });

    const leaderboard = await store.activeTimeLeaderboard("month");
    expect(leaderboard[0]?.displayName).toBe("Caleb");
    expect(leaderboard[0]?.estimatedMinutes).toBeGreaterThanOrEqual(8);
  });

  it("finds the latest conversation post for contextual replies", async () => {
    const store = await makeStore();
    await store.recordPost({
      id: "post-1",
      kind: "quiz",
      channelId: "channel-1",
      content: "A quiz should not trigger contextual replies.",
      at: new Date("2026-06-29T12:00:00.000Z"),
    });
    await store.recordPost({
      id: "post-2",
      kind: "prompt",
      channelId: "channel-1",
      content: "What is the one thing you need to move before lunch?",
      at: new Date("2026-06-29T12:05:00.000Z"),
    });

    const latest = await store.latestConversationPost("channel-1", 180, new Date("2026-06-29T13:00:00.000Z"));
    expect(latest).toMatchObject({
      id: "post-2",
      content: "What is the one thing you need to move before lunch?",
    });
  });

  it("matches a pending welcome by expected member name or email fragments", async () => {
    const store = await makeStore();
    const pending = await store.recordPendingWelcome({
      expectedName: "Andrew Ernst",
      email: "a.ernst@acernst.com",
      keywords: ["aernst", "acernst"],
      contractorCircleMember: true,
    });

    const match = await store.pendingWelcomeForMember({
      username: "aernst",
      displayName: "Andrew",
    });

    expect(match?.id).toBe(pending.id);
  });

  it("does not match public email domains or TLDs from rachel@gmail.com", async () => {
    const store = await makeStore();
    const pending = await store.recordPendingWelcome({
      expectedName: "Rachel Stone",
      email: "rachel@gmail.com",
      keywords: [],
      contractorCircleMember: true,
    });

    expect(pending.keywords).not.toContain("gmail");
    expect(pending.keywords).not.toContain("com");

    expect(
      await store.pendingWelcomeForMember({
        username: "rachel",
        displayName: "Rachel",
      }),
    ).toMatchObject({ id: pending.id });

    expect(
      await store.pendingWelcomeForMember({
        username: "comfort",
        displayName: "Company",
      }),
    ).toBeUndefined();
  });
});
