import { randomUUID } from "node:crypto";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type MessageCreateOptions,
  type TextBasedChannel,
} from "discord.js";
import type { AppConfig } from "./config.js";
import { logger } from "./logger.js";
import {
  buildCallRecapPost,
  buildMorningMessage,
  buildPromptPost,
  buildScheduledConversationPrompt,
  buildWelcomeMessage,
  ensureCallRecapContext,
} from "./messages.js";
import type { ActivityStore } from "./activityStore.js";
import type { AiService } from "./ai.js";
import type { ActivityWindow, CallRecapInput, QuizQuestion } from "./types.js";

type SendableTextChannel = TextBasedChannel & {
  id: string;
  send(content: string | MessageCreateOptions): Promise<Message>;
};

export class ContractorCircleBot {
  readonly client: Client;
  private readonly welcomeCache = new Map<string, number>();
  private readonly assistantReplyCache = new Map<string, number>();

  constructor(
    private readonly appConfig: AppConfig,
    private readonly store: ActivityStore,
    private readonly ai: AiService,
  ) {
    const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
    ];
    if (appConfig.discord.enableMessageContentIntent) {
      intents.push(GatewayIntentBits.MessageContent);
    }

    this.client = new Client({
      intents,
    });
  }

  async start() {
    if (!this.appConfig.discord.token) {
      logger.warn("DISCORD_BOT_TOKEN is missing; bot gateway will not start.");
      return false;
    }

    this.client.once(Events.ClientReady, (readyClient) => {
      logger.info(`Discord bot logged in as ${readyClient.user.tag}.`);
    });

    this.client.on(Events.GuildMemberAdd, (member) => {
      void this.handleGuildMemberAdd(member);
    });

    this.client.on(Events.GuildMemberUpdate, (_oldMember, newMember) => {
      void this.handleGuildMemberUpdate(newMember);
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.handleCommand(interaction);
      }
    });

    await this.client.login(this.appConfig.discord.token);
    return true;
  }

  async stop() {
    this.client.destroy();
  }

  async postMorningMessage() {
    const channel = await this.getAnnouncementChannel();
    const content = buildMorningMessage(new Date(), this.appConfig.schedule.timezone);
    const message = await channel.send(content);
    await this.store.recordPost({
      id: message.id,
      kind: "morning",
      channelId: channel.id,
    });
    return message;
  }

  async postConversationPrompt(channelId?: string, scheduledHour?: number) {
    const channel = channelId ? await this.getTextChannel(channelId) : await this.getAnnouncementChannel();
    const prompt =
      scheduledHour === undefined
        ? await this.generateAiConversationPrompt()
        : await this.generateScheduledConversationPrompt(scheduledHour);
    const message = await channel.send(buildPromptPost(prompt));
    await this.store.recordPost({
      id: message.id,
      kind: "prompt",
      channelId: channel.id,
    });
    return message;
  }

  async postQuiz(input: { channelId?: string; topic?: string; difficulty?: "easy" | "medium" | "hard" }) {
    const channel = input.channelId ? await this.getTextChannel(input.channelId) : await this.getAnnouncementChannel();
    const quizDraft = await this.ai.generateQuizQuestion({
      topic: input.topic,
      difficulty: input.difficulty,
    });
    const quizId = randomUUID().slice(0, 8);
    const message = await channel.send(formatQuizPost({ ...quizDraft, id: quizId }));
    const quiz = await this.store.recordQuiz({
      ...quizDraft,
      id: quizId,
      channelId: channel.id,
      messageId: message.id,
      ttlHours: 12,
    });
    await this.store.recordPost({
      id: message.id,
      kind: "quiz",
      channelId: channel.id,
    });
    return { message, quiz };
  }

  async postCallRecap(input: CallRecapInput) {
    const recap = await this.ai.generateCallRecap(input);
    const channel = input.channelId ? await this.getTextChannel(input.channelId) : await this.getAnnouncementChannel();
    const generatedContent = recap.suggestedPost?.trim() || buildCallRecapPost(recap);
    const content = ensureCallRecapContext(generatedContent, input.title, recap.headline);
    const message = await channel.send(content);
    await this.store.recordPost({
      id: message.id,
      kind: "call-recap",
      channelId: channel.id,
    });
    return { message, recap };
  }

  async postRawMessage(channelId: string, content: string, mentionUserIds: string[] = []) {
    const channel = await this.getTextChannel(channelId);
    return channel.send({
      content,
      allowedMentions: { users: mentionUserIds },
    });
  }

  async recordTargetedPrompt(input: {
    targetUserId: string;
    targetName: string;
    channelId: string;
    messageId: string;
    promptText: string;
  }) {
    return this.store.recordTargetedPrompt({
      ...input,
      responseWindowHours: this.appConfig.assistant.targetedPromptResponseHours,
    });
  }

  private async handleGuildMemberAdd(member: GuildMember) {
    if (member.guild.id !== this.appConfig.discord.guildId) return;
    if (this.wasRecentlyWelcomed(member.id)) {
      logger.info(`Skipping duplicate welcome for ${member.id}.`);
      return;
    }

    const contractorCircleMember = this.isContractorCircleMember(member);
    this.markWelcomed(member.id);
    await this.store.recordJoin({
      userId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      contractorCircleMember,
    });

    await this.tryAssignContractorCircleRole(member);

    const channel = await this.getAnnouncementChannel();
    const message = await channel.send(buildWelcomeMessage(member.id, contractorCircleMember));
    await this.store.recordPost({
      id: message.id,
      kind: "welcome",
      channelId: channel.id,
      userId: member.id,
    });
  }

  private async handleGuildMemberUpdate(member: GuildMember) {
    if (member.guild.id !== this.appConfig.discord.guildId) return;
    await this.store.recordJoin({
      userId: member.id,
      username: member.user.username,
      displayName: member.displayName,
      contractorCircleMember: this.isContractorCircleMember(member),
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || !message.guild || message.guild.id !== this.appConfig.discord.guildId) return;
    const member = message.member;
    await this.store.recordMessage({
      userId: message.author.id,
      username: message.author.username,
      displayName: member?.displayName || message.author.displayName || message.author.username,
      contractorCircleMember: member ? this.isContractorCircleMember(member) : undefined,
    });

    await this.maybeReplyToTargetedPrompt(message);
    await this.maybeReplyAsAssistant(message);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction) {
    if (interaction.guildId !== this.appConfig.discord.guildId) {
      await interaction.reply({ content: "This command is only available inside the Contractor Circle server.", ephemeral: true });
      return;
    }

    if (interaction.commandName === "recap") {
      await interaction.deferReply({ ephemeral: true });
      const title = interaction.options.getString("title") || "Contractor Circle call";
      const notes = interaction.options.getString("notes", true);
      const channel = interaction.options.getChannel("channel");
      const channelId = channel?.type === ChannelType.GuildText ? channel.id : undefined;
      const result = await this.postCallRecap({ title, notes, channelId });
      await interaction.editReply(`Recap posted in <#${result.message.channelId}>.`);
      return;
    }

    if (interaction.commandName === "prompt") {
      await interaction.deferReply({ ephemeral: true });
      const channel = interaction.options.getChannel("channel");
      const channelId = channel?.type === ChannelType.GuildText ? channel.id : undefined;
      const message = await this.postConversationPrompt(channelId);
      await interaction.editReply(`Prompt posted in <#${message.channelId}>.`);
      return;
    }

    if (interaction.commandName === "leaderboard") {
      const window = (interaction.options.getString("window") || "week") as ActivityWindow;
      const leaderboard = await this.store.leaderboard(window);
      await interaction.reply({ content: formatLeaderboard(leaderboard, window), ephemeral: false });
      return;
    }

    if (interaction.commandName === "quiz") {
      await interaction.deferReply({ ephemeral: true });
      const topic = interaction.options.getString("topic") || undefined;
      const difficulty = (interaction.options.getString("difficulty") || "medium") as "easy" | "medium" | "hard";
      const channel = interaction.options.getChannel("channel");
      const channelId = channel?.type === ChannelType.GuildText ? channel.id : undefined;
      const result = await this.postQuiz({ topic, difficulty, channelId });
      await interaction.editReply(`Quiz posted in <#${result.message.channelId}>. Quiz ID: ${result.quiz.id}`);
      return;
    }

    if (interaction.commandName === "answer") {
      const choice = interaction.options.getString("choice", true);
      const result = await this.answerLatestQuiz(interaction, choice);
      await interaction.reply({ content: result, ephemeral: true });
      return;
    }

    if (interaction.commandName === "quizleaderboard") {
      const window = (interaction.options.getString("window") || "week") as ActivityWindow;
      const leaderboard = await this.store.quizLeaderboard(window);
      await interaction.reply({ content: formatQuizLeaderboard(leaderboard, window), ephemeral: false });
      return;
    }

    if (interaction.commandName === "activetime") {
      const window = (interaction.options.getString("window") || "week") as ActivityWindow;
      const leaderboard = await this.store.activeTimeLeaderboard(window);
      await interaction.reply({ content: formatActiveTimeLeaderboard(leaderboard, window), ephemeral: true });
      return;
    }

    if (interaction.commandName === "ask") {
      await interaction.deferReply({ ephemeral: false });
      const question = interaction.options.getString("question", true);
      const reply = await this.ai.generateAssistantReply({
        message: question,
        authorName: interaction.member && "displayName" in interaction.member ? interaction.member.displayName : interaction.user.username,
        channelName: interaction.channel?.isTextBased() ? interaction.channel.toString() : undefined,
      });
      await interaction.editReply(safeDiscordContent(reply));
      return;
    }

    if (interaction.commandName === "goodmorning") {
      await interaction.deferReply({ ephemeral: true });
      const message = await this.postMorningMessage();
      await interaction.editReply(`Morning message posted in <#${message.channelId}>.`);
    }
  }

  private async answerLatestQuiz(interaction: ChatInputCommandInteraction, choice: string) {
    const channelId = interaction.channelId;
    const quiz = await this.store.latestOpenQuiz(channelId);
    if (!quiz) {
      return "No open quiz found in this channel. Ask Marshall or use `/quiz` to post one.";
    }

    const choiceIndex = parseChoice(choice);
    const displayName =
      interaction.member && "displayName" in interaction.member ? interaction.member.displayName : interaction.user.username;
    const result = await this.store.recordQuizAttempt({
      quizId: quiz.id,
      userId: interaction.user.id,
      username: interaction.user.username,
      displayName,
      choiceIndex,
    });

    if (result.alreadyAnswered) {
      const previous = formatChoiceLabel(result.attempt.choiceIndex);
      return `You already answered this quiz with ${previous}. ${result.attempt.correct ? "That was correct." : "That was not correct."}`;
    }

    const chosen = quiz.choices[choiceIndex] ?? "Unknown choice";
    if (result.attempt.correct) {
      return `Correct. ${formatChoiceLabel(choiceIndex)} ${chosen}\n\n${quiz.explanation}`;
    }

    return [
      `Not quite. You chose ${formatChoiceLabel(choiceIndex)} ${chosen}.`,
      `Correct answer: ${formatChoiceLabel(quiz.correctIndex)} ${quiz.choices[quiz.correctIndex]}`,
      "",
      quiz.explanation,
    ].join("\n");
  }

  private async maybeReplyAsAssistant(message: Message) {
    if (!this.appConfig.assistant.repliesEnabled || !this.client.user) return;

    const reference = await this.getReferencedBotMessage(message);
    const mentioned = message.mentions.users.has(this.client.user.id);
    if (!reference && !mentioned) return;

    const cacheKey = `${message.author.id}:${message.channelId}`;
    const lastReply = this.assistantReplyCache.get(cacheKey);
    const cooldownMs = this.appConfig.assistant.replyCooldownSeconds * 1000;
    if (lastReply && cooldownMs > 0 && Date.now() - lastReply < cooldownMs) {
      logger.info(`Skipping assistant reply because ${message.author.id} is on cooldown.`);
      return;
    }
    this.assistantReplyCache.set(cacheKey, Date.now());

    const messageText = stripBotMention(message.content || "", this.client.user.id);
    const member = message.member;
    const reply = await this.ai.generateAssistantReply({
      message: messageText,
      authorName: member?.displayName || message.author.displayName || message.author.username,
      channelName: "name" in message.channel ? (message.channel.name ?? undefined) : undefined,
      referencedBotMessage: reference?.content,
    });

    await message.reply({
      content: safeDiscordContent(reply),
      allowedMentions: { repliedUser: false },
    });
  }

  private async maybeReplyToTargetedPrompt(message: Message) {
    if (!this.appConfig.assistant.repliesEnabled) return;
    const pending = await this.store.pendingTargetedPromptFor(message.author.id, message.channelId);
    if (!pending) return;

    const cacheKey = `targeted:${message.author.id}:${message.channelId}`;
    const lastReply = this.assistantReplyCache.get(cacheKey);
    const cooldownMs = this.appConfig.assistant.replyCooldownSeconds * 1000;
    if (lastReply && cooldownMs > 0 && Date.now() - lastReply < cooldownMs) return;
    this.assistantReplyCache.set(cacheKey, Date.now());
    await this.store.markTargetedPromptResponded(pending.id);

    const member = message.member;
    const reply = await this.ai.generateAssistantReply({
      message: message.content || "",
      authorName: member?.displayName || message.author.displayName || message.author.username,
      channelName: "name" in message.channel ? (message.channel.name ?? undefined) : undefined,
      referencedBotMessage: pending.promptText,
    });

    await message.reply({
      content: safeDiscordContent(reply),
      allowedMentions: { repliedUser: false },
    });
  }

  private async getReferencedBotMessage(message: Message) {
    if (!message.reference?.messageId || !this.client.user) return undefined;
    try {
      const referenced = await message.fetchReference();
      return referenced.author.id === this.client.user.id ? referenced : undefined;
    } catch (error: any) {
      logger.warn("Could not fetch referenced message for assistant reply.", error?.message);
      return undefined;
    }
  }

  private async generateAiConversationPrompt() {
    const dateText = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeZone: this.appConfig.schedule.timezone,
    }).format(new Date());
    const recent = await this.store.recentActiveUsers(this.appConfig.schedule.recentActivityLookbackMinutes);
    return this.ai.generateConversationPrompt({
      activeUserCount: recent.length,
      dateText,
    });
  }

  private async generateScheduledConversationPrompt(hour: number) {
    if (!this.appConfig.schedule.useAiScheduledPrompts) {
      return buildScheduledConversationPrompt(hour);
    }

    const dateText = new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeZone: this.appConfig.schedule.timezone,
    }).format(new Date());
    const recent = await this.store.recentActiveUsers(this.appConfig.schedule.recentActivityLookbackMinutes);
    return this.ai.generateScheduledConversationPrompt({
      hour,
      activeUserCount: recent.length,
      dateText,
    });
  }

  private async tryAssignContractorCircleRole(member: GuildMember) {
    for (const roleId of this.appConfig.discord.contractorCircleRoleIds) {
      if (!roleId || member.roles.cache.has(roleId)) continue;
      try {
        await member.roles.add(roleId, "Contractor Circle welcome automation");
        logger.info(`Assigned Contractor Circle role ${roleId} to ${member.id}.`);
        return;
      } catch (error: any) {
        logger.warn(`Could not assign Contractor Circle role ${roleId} to ${member.id}.`, error?.message);
      }
    }
  }

  private isContractorCircleMember(member: GuildMember) {
    const roleIds = new Set(this.appConfig.discord.contractorCircleRoleIds);
    return member.roles.cache.some((role) => {
      return roleIds.has(role.id) || this.appConfig.discord.contractorCircleRoleNames.includes(role.name.toLowerCase());
    });
  }

  private wasRecentlyWelcomed(memberId: string) {
    const last = this.welcomeCache.get(memberId);
    if (!last) return false;
    return Date.now() - last < this.appConfig.welcomeDedupMinutes * 60 * 1000;
  }

  private markWelcomed(memberId: string) {
    this.welcomeCache.set(memberId, Date.now());
    if (this.welcomeCache.size <= 500) return;
    const cutoff = Date.now() - this.appConfig.welcomeDedupMinutes * 60 * 1000;
    for (const [id, timestamp] of this.welcomeCache) {
      if (timestamp < cutoff) this.welcomeCache.delete(id);
    }
  }

  private async getAnnouncementChannel() {
    return this.getTextChannel(this.appConfig.discord.announcementsChannelId);
  }

  private async getTextChannel(channelId: string): Promise<SendableTextChannel> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} is not a text channel or cannot be fetched.`);
    }
    return channel as SendableTextChannel;
  }
}

function formatLeaderboard(leaderboard: Array<{ displayName: string; messageCount: number }>, window: ActivityWindow) {
  if (!leaderboard.length) {
    return `No activity recorded for this ${window} yet.`;
  }
  const rows = leaderboard.map((item, index) => `${index + 1}. ${item.displayName} - ${item.messageCount} messages`);
  return [`Contractor Circle activity leaderboard (${window})`, "", ...rows].join("\n");
}

function formatQuizPost(quiz: Pick<QuizQuestion, "id" | "topic" | "question" | "choices">) {
  const choices = quiz.choices.map((choice, index) => `${formatChoiceLabel(index)} ${choice}`).join("\n");
  return [
    `ALP Think quiz: ${quiz.topic}`,
    "",
    quiz.question,
    "",
    choices,
    "",
    "Answer with `/answer` and pick A, B, C, or D. I’ll track the leaderboard.",
  ].join("\n");
}

function formatQuizLeaderboard(
  leaderboard: Array<{ displayName: string; points: number; correct: number; attempts: number }>,
  window: ActivityWindow,
) {
  if (!leaderboard.length) {
    return `No quiz answers recorded for this ${window} yet.`;
  }
  const rows = leaderboard.map((item, index) => {
    return `${index + 1}. ${item.displayName} - ${item.points} pts (${item.correct}/${item.attempts})`;
  });
  return [`ALP Think quiz leaderboard (${window})`, "", ...rows].join("\n");
}

function formatActiveTimeLeaderboard(
  leaderboard: Array<{ displayName: string; estimatedMinutes: number }>,
  window: ActivityWindow,
) {
  if (!leaderboard.length) {
    return `No estimated active time recorded for this ${window} yet.`;
  }
  const rows = leaderboard.map((item, index) => {
    return `${index + 1}. ${item.displayName} - ${formatMinutes(item.estimatedMinutes)}`;
  });
  return [
    `Estimated Discord active time (${window})`,
    "",
    ...rows,
    "",
    "This is an estimate based on messages and quiz participation, not private Discord read time.",
  ].join("\n");
}

function parseChoice(choice: string) {
  const normalized = choice.trim().toUpperCase();
  const map: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
  return map[normalized] ?? 0;
}

function formatChoiceLabel(index: number) {
  return `${String.fromCharCode(65 + index)}.`;
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function stripBotMention(content: string, botId: string) {
  return content
    .replace(new RegExp(`<@!?${botId}>`, "g"), "")
    .trim();
}

function safeDiscordContent(content: string) {
  const trimmed = content.trim() || "I need a little more context to help with that.";
  if (trimmed.length <= 1900) return trimmed;
  return `${trimmed.slice(0, 1890).trimEnd()}...`;
}
