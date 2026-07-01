import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActiveTimeLeaderboardRow,
  ActivityRecord,
  ActivityStoreState,
  ActivityWindow,
  QuizAttempt,
  QuizLeaderboardRow,
  QuizQuestion,
  TargetedPrompt,
} from "./types.js";
import { logger } from "./logger.js";

const emptyState = (): ActivityStoreState => ({
  users: {},
  posts: [],
  targetedPrompts: [],
  quizzes: [],
  quizAttempts: [],
  activityEvents: [],
});

export class ActivityStore {
  private state: ActivityStoreState = emptyState();
  private loaded = false;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.resolve(dataDir, "activity.json");
  }

  async load() {
    if (this.loaded) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = JSON.parse(raw) as ActivityStoreState;
      this.state.targetedPrompts ??= [];
      this.state.quizzes ??= [];
      this.state.quizAttempts ??= [];
      this.state.activityEvents ??= [];
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        logger.warn("Could not read activity store; starting fresh.", error?.message);
      }
      this.state = emptyState();
    }
    this.loaded = true;
  }

  async save() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  async recordMessage(input: {
    userId: string;
    username: string;
    displayName: string;
    contractorCircleMember?: boolean;
    at?: Date;
  }) {
    await this.load();
    const now = (input.at ?? new Date()).toISOString();
    const existing = this.state.users[input.userId];
    const activity = calculateActivityMinutes(existing?.lastActiveAt, now);
    this.state.users[input.userId] = {
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      messageCount: (existing?.messageCount ?? 0) + 1,
      lastMessageAt: now,
      joinedAt: existing?.joinedAt,
      contractorCircleMember: input.contractorCircleMember ?? existing?.contractorCircleMember,
      estimatedActiveMinutes: (existing?.estimatedActiveMinutes ?? 0) + activity,
      lastActiveAt: now,
      quizPoints: existing?.quizPoints ?? 0,
      quizCorrect: existing?.quizCorrect ?? 0,
      quizAttempts: existing?.quizAttempts ?? 0,
    };
    this.recordActivityEvent(input.userId, input.displayName, activity, "message", now);
    await this.save();
  }

  async recordJoin(input: {
    userId: string;
    username: string;
    displayName: string;
    contractorCircleMember: boolean;
    at?: Date;
  }) {
    await this.load();
    const now = (input.at ?? new Date()).toISOString();
    const existing = this.state.users[input.userId];
    this.state.users[input.userId] = {
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      messageCount: existing?.messageCount ?? 0,
      lastMessageAt: existing?.lastMessageAt ?? now,
      joinedAt: existing?.joinedAt ?? now,
      contractorCircleMember: input.contractorCircleMember,
      estimatedActiveMinutes: existing?.estimatedActiveMinutes ?? 0,
      lastActiveAt: existing?.lastActiveAt,
      quizPoints: existing?.quizPoints ?? 0,
      quizCorrect: existing?.quizCorrect ?? 0,
      quizAttempts: existing?.quizAttempts ?? 0,
    };
    await this.save();
  }

  async recordPost(input: {
    id: string;
    kind: ActivityStoreState["posts"][number]["kind"];
    channelId: string;
    content?: string;
    userId?: string;
    at?: Date;
  }) {
    await this.load();
    this.state.posts.push({
      id: input.id,
      kind: input.kind,
      channelId: input.channelId,
      content: input.content,
      userId: input.userId,
      createdAt: (input.at ?? new Date()).toISOString(),
    });
    this.state.posts = this.state.posts.slice(-500);
    await this.save();
  }

  async lastPostAt(kind: ActivityStoreState["posts"][number]["kind"]) {
    await this.load();
    const last = [...this.state.posts].reverse().find((post) => post.kind === kind);
    return last ? new Date(last.createdAt) : undefined;
  }

  async lastCommunityPostAt() {
    await this.load();
    const last = [...this.state.posts].reverse().find((post) => {
      return post.kind === "morning" || post.kind === "prompt" || post.kind === "call-recap";
    });
    return last ? new Date(last.createdAt) : undefined;
  }

  async latestConversationPost(channelId: string, lookbackMinutes: number, now = new Date()) {
    await this.load();
    const cutoff = now.getTime() - lookbackMinutes * 60 * 1000;
    return [...this.state.posts].reverse().find((post) => {
      if (post.channelId !== channelId) return false;
      if (new Date(post.createdAt).getTime() < cutoff) return false;
      return post.kind === "morning" || post.kind === "prompt" || post.kind === "call-recap";
    });
  }

  async recordTargetedPrompt(input: {
    targetUserId: string;
    targetName: string;
    channelId: string;
    messageId: string;
    promptText: string;
    responseWindowHours: number;
    at?: Date;
  }) {
    await this.load();
    const now = input.at ?? new Date();
    const prompt: TargetedPrompt = {
      id: `${input.channelId}:${input.messageId}`,
      targetUserId: input.targetUserId,
      targetName: input.targetName,
      channelId: input.channelId,
      messageId: input.messageId,
      promptText: input.promptText,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.responseWindowHours * 60 * 60 * 1000).toISOString(),
    };
    this.state.targetedPrompts = [
      ...this.state.targetedPrompts.filter((item) => item.id !== prompt.id),
      prompt,
    ].slice(-100);
    await this.save();
    return prompt;
  }

  async pendingTargetedPromptFor(userId: string, channelId: string, now = new Date()) {
    await this.load();
    return [...this.state.targetedPrompts].reverse().find((prompt) => {
      return (
        prompt.targetUserId === userId &&
        prompt.channelId === channelId &&
        !prompt.respondedAt &&
        new Date(prompt.expiresAt).getTime() >= now.getTime()
      );
    });
  }

  async markTargetedPromptResponded(id: string, at = new Date()) {
    await this.load();
    const prompt = this.state.targetedPrompts.find((item) => item.id === id);
    if (!prompt) return;
    prompt.respondedAt = at.toISOString();
    await this.save();
  }

  async recordQuiz(input: Omit<QuizQuestion, "createdAt" | "expiresAt"> & { ttlHours: number; at?: Date }) {
    await this.load();
    const now = input.at ?? new Date();
    const quiz: QuizQuestion = {
      id: input.id,
      channelId: input.channelId,
      messageId: input.messageId,
      topic: input.topic,
      question: input.question,
      choices: input.choices,
      correctIndex: input.correctIndex,
      explanation: input.explanation,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlHours * 60 * 60 * 1000).toISOString(),
    };
    this.state.quizzes = [...this.state.quizzes.filter((item) => item.id !== quiz.id), quiz].slice(-200);
    await this.save();
    return quiz;
  }

  async latestOpenQuiz(channelId: string, now = new Date()) {
    await this.load();
    return [...this.state.quizzes]
      .reverse()
      .find((quiz) => quiz.channelId === channelId && new Date(quiz.expiresAt).getTime() >= now.getTime());
  }

  async recordQuizAttempt(input: {
    quizId: string;
    userId: string;
    username: string;
    displayName: string;
    choiceIndex: number;
    at?: Date;
  }) {
    await this.load();
    const quiz = this.state.quizzes.find((item) => item.id === input.quizId);
    if (!quiz) {
      throw new Error("Quiz not found.");
    }

    const existing = this.state.quizAttempts.find((attempt) => {
      return attempt.quizId === input.quizId && attempt.userId === input.userId;
    });
    if (existing) {
      return { quiz, attempt: existing, alreadyAnswered: true };
    }

    const now = (input.at ?? new Date()).toISOString();
    const correct = input.choiceIndex === quiz.correctIndex;
    const attempt: QuizAttempt = {
      quizId: input.quizId,
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      choiceIndex: input.choiceIndex,
      correct,
      points: correct ? 1 : 0,
      answeredAt: now,
    };
    this.state.quizAttempts = [...this.state.quizAttempts, attempt].slice(-1000);

    const existingUser = this.state.users[input.userId];
    const activity = calculateActivityMinutes(existingUser?.lastActiveAt, now);
    this.state.users[input.userId] = {
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      messageCount: existingUser?.messageCount ?? 0,
      lastMessageAt: existingUser?.lastMessageAt ?? now,
      joinedAt: existingUser?.joinedAt,
      contractorCircleMember: existingUser?.contractorCircleMember,
      estimatedActiveMinutes: (existingUser?.estimatedActiveMinutes ?? 0) + activity,
      lastActiveAt: now,
      quizPoints: (existingUser?.quizPoints ?? 0) + attempt.points,
      quizCorrect: (existingUser?.quizCorrect ?? 0) + (correct ? 1 : 0),
      quizAttempts: (existingUser?.quizAttempts ?? 0) + 1,
    };
    this.recordActivityEvent(input.userId, input.displayName, activity, "quiz", now);
    await this.save();
    return { quiz, attempt, alreadyAnswered: false };
  }

  async quizLeaderboard(window: ActivityWindow, limit = 10): Promise<QuizLeaderboardRow[]> {
    await this.load();
    const cutoff = windowCutoff(window).getTime();
    const rows = new Map<string, QuizLeaderboardRow>();
    for (const attempt of this.state.quizAttempts) {
      if (new Date(attempt.answeredAt).getTime() < cutoff) continue;
      const row = rows.get(attempt.userId) ?? {
        userId: attempt.userId,
        displayName: attempt.displayName,
        points: 0,
        correct: 0,
        attempts: 0,
      };
      row.displayName = attempt.displayName;
      row.points += attempt.points;
      row.correct += attempt.correct ? 1 : 0;
      row.attempts += 1;
      rows.set(attempt.userId, row);
    }
    return [...rows.values()]
      .sort((a, b) => b.points - a.points || b.correct - a.correct || a.displayName.localeCompare(b.displayName))
      .slice(0, limit);
  }

  async activeTimeLeaderboard(window: ActivityWindow, limit = 10): Promise<ActiveTimeLeaderboardRow[]> {
    await this.load();
    const cutoff = windowCutoff(window).getTime();
    const rows = new Map<string, ActiveTimeLeaderboardRow>();
    for (const event of this.state.activityEvents) {
      if (new Date(event.at).getTime() < cutoff) continue;
      const user = this.state.users[event.userId];
      const row = rows.get(event.userId) ?? {
        userId: event.userId,
        displayName: event.displayName,
        estimatedMinutes: 0,
        messageCount: 0,
        quizAttempts: 0,
      };
      row.displayName = event.displayName;
      row.estimatedMinutes += event.minutes;
      row.messageCount = user?.messageCount ?? row.messageCount;
      row.quizAttempts = user?.quizAttempts ?? row.quizAttempts;
      rows.set(event.userId, row);
    }
    return [...rows.values()]
      .sort((a, b) => b.estimatedMinutes - a.estimatedMinutes || a.displayName.localeCompare(b.displayName))
      .slice(0, limit);
  }

  async recentActiveUsers(lookbackMinutes: number, now = new Date()) {
    await this.load();
    const cutoff = now.getTime() - lookbackMinutes * 60 * 1000;
    return Object.values(this.state.users).filter((user) => new Date(user.lastMessageAt).getTime() >= cutoff);
  }

  async leaderboard(window: ActivityWindow, limit = 10): Promise<ActivityRecord[]> {
    await this.load();
    const cutoff = windowCutoff(window).getTime();
    return Object.values(this.state.users)
      .filter((user) => new Date(user.lastMessageAt).getTime() >= cutoff)
      .sort((a, b) => b.messageCount - a.messageCount || a.displayName.localeCompare(b.displayName))
      .slice(0, limit);
  }

  private recordActivityEvent(
    userId: string,
    displayName: string,
    minutes: number,
    kind: "message" | "quiz",
    at: string,
  ) {
    this.state.activityEvents.push({ userId, displayName, minutes, kind, at });
    this.state.activityEvents = this.state.activityEvents.slice(-10000);
  }
}

function windowCutoff(window: ActivityWindow) {
  const now = new Date();
  const days = window === "day" ? 1 : window === "week" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function calculateActivityMinutes(lastActiveAt: string | undefined, nowIso: string) {
  if (!lastActiveAt) return 1;
  const deltaMinutes = Math.round((new Date(nowIso).getTime() - new Date(lastActiveAt).getTime()) / 60000);
  if (!Number.isFinite(deltaMinutes) || deltaMinutes <= 0) return 1;
  return Math.min(deltaMinutes, 15);
}
