import {
  MessageFlags,
  SlashCommandBuilder,
  ComponentType,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Message,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Command, CommandCategory } from "../../types/command.js";
import type { SyndicateClient } from "../../core/client.js";
import { config } from "../../core/config.js";
import { log } from "../../core/logger.js";
import { errorEmbed } from "../../lib/embeds.js";
import {
  buildHelpHomeEmbed,
  buildCategoryEmbed,
  buildCommandDetailEmbed,
  buildCategorySelectRow,
  buildInviteButtonRow,
  type HelpViewer,
} from "../../lib/help.js";

const COLLECTOR_TIMEOUT_MS = 180_000;

const command: Command = {
  category: "utility",
  surface: "both",
  usage: ">help [command]",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Browse Syndicate Bot's commands — or look up any command's exact usage.")
    .addStringOption((opt) =>
      opt
        .setName("command")
        .setDescription("A specific command to get detailed usage for, e.g. 'remindme'")
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const client = interaction.client as SyndicateClient;
    const viewer: HelpViewer = {
      userId: interaction.user.id,
      isAdminHere: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
    };

    // Detail page for /help <command>
    const commandName = interaction.options.getString("command")?.trim().toLowerCase();
    if (commandName) {
      log.info("HELP", `/help detail requested by ${interaction.user.id}: "${commandName}"`);
      const detail = buildCommandDetailEmbed(client, commandName, viewer);
      if (!detail) {
        await interaction.reply({
          embeds: [
            errorEmbed(
              `I don't know a command called \`${commandName}\`. Run \`/help\` and browse the categories to see everything I can do.`,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({ embeds: [detail] });
      return;
    }

    log.info("HELP", `/help menu opened by ${interaction.user.tag} (${interaction.user.id})`);
    await sendHomeMenu(interaction, client, viewer);
  },

  prefixNames: ["help", "commands", "h"],
  async prefixExecute(message: Message, args: string[]) {
    const client = message.client as SyndicateClient;
    const viewer: HelpViewer = {
      userId: message.author.id,
      isAdminHere: message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
    };

    // >help <command> — detail page
    const commandName = args[0]?.toLowerCase();
    if (commandName) {
      log.info("HELP", `>help detail requested by ${message.author.id}: "${commandName}"`);
      const detail = buildCommandDetailEmbed(client, commandName, viewer);
      if (!detail) {
        await message.reply({
          embeds: [
            errorEmbed(
              `I don't know a command called \`${commandName}\`. Run \`${config.prefix}help\` and browse the categories to see everything I can do.`,
            ),
          ],
        });
        return;
      }
      await message.reply({ embeds: [detail] });
      return;
    }

    log.info("HELP", `>help menu opened by ${message.author.tag} (${message.author.id})`);
    await sendHomeMenuPrefix(message, client, viewer);
  },
};

async function sendHomeMenu(
  interaction: ChatInputCommandInteraction,
  client: SyndicateClient,
  viewer: HelpViewer,
) {
  const row = buildCategorySelectRow(client, viewer);
  const inviteRow = buildInviteButtonRow();

  const response = await interaction.reply({
    embeds: [buildHelpHomeEmbed(client, viewer)],
    components: [row, inviteRow],
    withResponse: true,
  });

  const collector = response.resource!.message!.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: COLLECTOR_TIMEOUT_MS,
  });

  collector.on("collect", async (i: StringSelectMenuInteraction) => {
    try {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: "This help menu isn't yours — run `/help` to get your own!", flags: MessageFlags.Ephemeral });
        return;
      }

      const choice = i.values[0];
      const embed =
        choice === "home"
          ? buildHelpHomeEmbed(client, viewer)
          : buildCategoryEmbed(client, choice as CommandCategory);

      await i.update({ embeds: [embed], components: [row, inviteRow] });
    } catch (error) {
      log.error("HELP", "Failed to handle select menu interaction", error);
    }
  });

  collector.on("end", () => {
    interaction.editReply({ components: [] }).catch(() => null);
  });
}

async function sendHomeMenuPrefix(
  message: Message,
  client: SyndicateClient,
  viewer: HelpViewer,
) {
  const row = buildCategorySelectRow(client, viewer);
  const inviteRow = buildInviteButtonRow();

  const sent = await message.reply({ embeds: [buildHelpHomeEmbed(client, viewer)], components: [row, inviteRow] });

  const collector = sent.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: COLLECTOR_TIMEOUT_MS,
  });

  collector.on("collect", async (i: StringSelectMenuInteraction) => {
    try {
      if (i.user.id !== message.author.id) {
        await i.reply({ content: "This help menu isn't yours — run `>help` to get your own!", flags: MessageFlags.Ephemeral });
        return;
      }

      const choice = i.values[0];
      const embed =
        choice === "home"
          ? buildHelpHomeEmbed(client, viewer)
          : buildCategoryEmbed(client, choice as CommandCategory);

      await i.update({ embeds: [embed], components: [row, inviteRow] });
    } catch (error) {
      log.error("HELP", "Failed to handle select menu interaction", error);
    }
  });

  collector.on("end", () => {
    sent.edit({ components: [] }).catch(() => null);
  });
}

export default command;
