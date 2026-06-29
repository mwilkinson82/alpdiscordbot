import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
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
import type { ActivityWindow, CallRecapInput } from "./types.js";

type SendableTextChannel = TextBasedChannel & {
  id: string;
  send(content: string): Promise<Message>;
};

export class ContractorCircleBot {
  readonly client: Client;
  private readonly welcomeCache = new Map<string, number>();

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

    if (interaction.commandName === "goodmorning") {
      await interaction.deferReply({ ephemeral: true });
      const message = await this.postMorningMessage();
      await interaction.editReply(`Morning message posted in <#${message.channelId}>.`);
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
