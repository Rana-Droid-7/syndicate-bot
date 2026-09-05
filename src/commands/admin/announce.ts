import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed, successEmbed } from "../../lib/embeds.js";
import { isAdmin } from "../../lib/permissions.js";
import { log } from "../../core/logger.js";
import { safeErrorText } from "../../lib/safeError.js";

const command: Command = {
  category: "admin",
  surface: "slash-only",
  usage: "/announce <channel> <message> [title]",
  description: "Post an announcement to any channel as the bot.",
  details:
    "Has something to say but want it to come from the server, not from you? " +
    "This posts your message as a clean, branded embed in any text channel you pick — " +
    "great for rules, events, and updates. The announcement renders as the bot, so " +
    "it won't carry your name. Requires Administrator, and the bot needs permission " +
    "to send messages in the target channel.",
  data: new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Post an announcement to a channel as the bot. (Admin only)")
    .addChannelOption((opt) => opt.setName("channel").setDescription("Where to post it").setRequired(true))
    .addStringOption((opt) =>
      opt.setName("message").setDescription("The announcement text").setRequired(true).setMaxLength(2000),
    )
    .addStringOption((opt) =>
      opt.setName("title").setDescription("Optional title").setRequired(false).setMaxLength(256),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "This command only works in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member || !isAdmin(member)) {
      log.warn("ADMIN", `/announce denied — ${interaction.user.id} lacks Administrator.`);
      await interaction.reply({ content: "You need Administrator permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    const message = interaction.options.getString("message", true);
    const title = interaction.options.getString("title");
    log.info("CMD", `/announce invoked by ${interaction.user.tag} (${interaction.user.id}) targeting channel ${channel.id}`);

    const targetChannel = await interaction.guild.channels.fetch(channel.id).catch(() => null);
    if (!targetChannel || !targetChannel.isTextBased() || !("send" in targetChannel)) {
      await interaction.reply({ content: "I can't post to that channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    const embed = baseEmbed().setDescription(message);
    if (title) embed.setTitle(title);

    try {
      await (targetChannel as TextChannel).send({ embeds: [embed] });
      log.info("ADMIN", `/announce SUCCESS: ${interaction.user.id} posted to channel ${channel.id} in guild ${interaction.guild.id}.`);
    } catch (error) {
      log.error("ADMIN", `/announce FAILED posting to channel ${channel.id}`, error);
      await interaction.reply({
        embeds: [errorEmbed(`Couldn't post there: ${safeErrorText(error)}. Check that I have permission to send messages in that channel.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [successEmbed(`Announcement posted in <#${channel.id}>.`)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export default command;
