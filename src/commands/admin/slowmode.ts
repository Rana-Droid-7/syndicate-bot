import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { errorEmbed, successEmbed } from "../../lib/embeds.js";
import { isAdmin } from "../../lib/permissions.js";
import { log } from "../../core/logger.js";
import { safeErrorText } from "../../lib/safeError.js";

const MAX_SLOWMODE_SECONDS = 21600; // Discord's own cap: 6 hours

const command: Command = {
  category: "admin",
  surface: "slash-only",
  usage: "/slowmode <seconds> [channel]",
  description: "Set slowmode on a channel (0 disables).",
  details:
    "Limits how fast members can send messages in a channel — one message per " +
    "interval per member. Use it to tame busy channels without hard-locking them. " +
    "`0` turns it off. Discord caps slowmode at 6 hours; pick a channel or it " +
    "applies to the one you're in. Requires Administrator (plus Manage Channels " +
    "on the bot).",
  data: new SlashCommandBuilder()
    .setName("slowmode")
    .setDescription("Set slowmode on a channel. (Admin only)")
    .addIntegerOption((opt) =>
      opt
        .setName("seconds")
        .setDescription("Seconds between messages (0 to disable, max 21600)")
        .setMinValue(0)
        .setMaxValue(MAX_SLOWMODE_SECONDS)
        .setRequired(true),
    )
    .addChannelOption((opt) =>
      opt.setName("channel").setDescription("Channel to apply this to (defaults to current channel)").setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "This command only works in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member || !isAdmin(member)) {
      log.warn("ADMIN", `/slowmode denied — ${interaction.user.id} lacks Administrator.`);
      await interaction.reply({ content: "You need Administrator permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const seconds = interaction.options.getInteger("seconds", true);
    const channelOption = interaction.options.getChannel("channel");
    const channelId = channelOption?.id ?? interaction.channelId;
    log.info("CMD", `/slowmode invoked by ${interaction.user.tag} (${interaction.user.id}): ${seconds}s on channel ${channelId}`);

    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !("setRateLimitPerUser" in channel)) {
      await interaction.reply({ content: "I can't set slowmode on that channel type.", flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await (channel as TextChannel).setRateLimitPerUser(seconds);
      log.info("ADMIN", `/slowmode SUCCESS: ${interaction.user.id} set ${seconds}s on channel ${channelId} in guild ${interaction.guild.id}.`);
    } catch (error) {
      log.error("ADMIN", `/slowmode FAILED on channel ${channelId}`, error);
      await interaction.reply({
        embeds: [errorEmbed(`Couldn't set slowmode there: ${safeErrorText(error)}. Check that I have Manage Channels permission.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        successEmbed(
          seconds > 0
            ? `Slowmode set to **${seconds}s** in <#${channelId}>.`
            : `Slowmode disabled in <#${channelId}>.`,
        ),
      ],
    });
  },
};

export default command;
