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
  estimatedActiveMinutes?: number;
  lastActiveAt?: string;
  quizPoints?: number;
  quizCorrect?: number;
  quizAttempts?: number;
}

export interface ActivityStoreState {
  users: Record<string, ActivityRecord>;
  posts: Array<{
    id: string;
    kind: "welcome" | "morning" | "prompt" | "call-recap" | "quiz";
    channelId: string;
    createdAt: string;
    content?: string;
    userId?: string;
  }>;
  targetedPrompts: TargetedPrompt[];
  quizzes: QuizQuestion[];
  quizAttempts: QuizAttempt[];
  activityEvents: ActivityEvent[];
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

export interface QuizQuestion {
  id: string;
  channelId: string;
  messageId?: string;
  topic: string;
  question: string;
  choices: string[];
  correctIndex: number;
  explanation: string;
  createdAt: string;
  expiresAt: string;
}

export interface QuizAttempt {
  quizId: string;
  userId: string;
  username: string;
  displayName: string;
  choiceIndex: number;
  correct: boolean;
  points: number;
  answeredAt: string;
}

export interface ActivityEvent {
  userId: string;
  displayName: string;
  minutes: number;
  kind: "message" | "quiz";
  at: string;
}

export interface QuizLeaderboardRow {
  userId: string;
  displayName: string;
  points: number;
  correct: number;
  attempts: number;
}

export interface ActiveTimeLeaderboardRow {
  userId: string;
  displayName: string;
  estimatedMinutes: number;
  messageCount: number;
  quizAttempts: number;
}
