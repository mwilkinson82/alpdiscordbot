import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ActivityRecord, ActivityStoreState, ActivityWindow } from "./types.js";
import { logger } from "./logger.js";

const emptyState = (): ActivityStoreState => ({
  users: {},
  posts: [],
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
    this.state.users[input.userId] = {
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      messageCount: (existing?.messageCount ?? 0) + 1,
      lastMessageAt: now,
      joinedAt: existing?.joinedAt,
      contractorCircleMember: input.contractorCircleMember ?? existing?.contractorCircleMember,
    };
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
    };
    await this.save();
  }

  async recordPost(input: {
    id: string;
    kind: ActivityStoreState["posts"][number]["kind"];
    channelId: string;
    userId?: string;
    at?: Date;
  }) {
    await this.load();
    this.state.posts.push({
      id: input.id,
      kind: input.kind,
      channelId: input.channelId,
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
}

function windowCutoff(window: ActivityWindow) {
  const now = new Date();
  const days = window === "day" ? 1 : window === "week" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
