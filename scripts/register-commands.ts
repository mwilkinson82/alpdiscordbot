import "dotenv/config";
import { ChannelType, REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "../src/config.js";

if (!config.discord.token) {
  throw new Error("DISCORD_BOT_TOKEN is required to register commands.");
}

if (!config.discord.clientId) {
  throw new Error("DISCORD_CLIENT_ID is required to register commands.");
}

const commands = [
  new SlashCommandBuilder()
    .setName("recap")
    .setDescription("Create and post a Contractor Circle call recap.")
    .addStringOption((option) =>
      option.setName("notes").setDescription("Paste transcript or call notes.").setRequired(true).setMaxLength(4000),
    )
    .addStringOption((option) =>
      option.setName("title").setDescription("Optional call title.").setRequired(false).setMaxLength(120),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Optional channel to post into.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("prompt")
    .setDescription("Post a Contractor Circle conversation starter.")
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Optional channel to post into.")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the activity leaderboard.")
    .addStringOption((option) =>
      option
        .setName("window")
        .setDescription("Activity window.")
        .addChoices({ name: "Day", value: "day" }, { name: "Week", value: "week" }, { name: "Month", value: "month" })
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask the ALP Assistant a Contractor Circle question.")
    .addStringOption((option) =>
      option.setName("question").setDescription("What do you want help thinking through?").setRequired(true).setMaxLength(1000),
    ),
  new SlashCommandBuilder().setName("goodmorning").setDescription("Post the morning message now."),
].map((command) => command.toJSON());

const rest = new REST({ version: "10" }).setToken(config.discord.token);

await rest.put(Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId), {
  body: commands,
});

console.log(`Registered ${commands.length} guild slash commands for ${config.discord.guildId}.`);
