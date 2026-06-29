export type LogLevel = "debug" | "info" | "warn" | "error";

export type ActivityWindow = "day" | "week" | "month";

export interface ActivityRecord {
  userId: string;
  username: string;
  displayName: string;
  messageCount: number;
  lastMessageAt: string;
  joinedAt?: string;
  contractorCircleMember?: boolean;
}

export interface ActivityStoreState {
  users: Record<string, ActivityRecord>;
  posts: Array<{
    id: string;
    kind: "welcome" | "morning" | "prompt" | "call-recap";
    channelId: string;
    createdAt: string;
    userId?: string;
  }>;
  targetedPrompts: TargetedPrompt[];
}

export interface TargetedPrompt {
  id: string;
  targetUserId: string;
  targetName: string;
  channelId: string;
  messageId: string;
  promptText: string;
  createdAt: string;
  expiresAt: string;
  respondedAt?: string;
}

export interface CallRecapInput {
  title?: string;
  speaker?: string;
  transcript?: string;
  notes?: string;
  channelId?: string;
}

export interface CallRecap {
  headline: string;
  summary: string;
  keyPoints: string[];
  discussionQuestion: string;
  suggestedPost: string;
}

export interface ConversationPrompt {
  prompt: string;
  reason: string;
}
