import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { errorEmbed, successEmbed } from "../../lib/embeds.js";
import { confirmAction } from "../../lib/confirm.js";
import { log } from "../../core/logger.js";
import { safeErrorText } from "../../lib/safeError.js";

const command: Command = {
  category: "moderation",
  surface: "slash-only",
  usage: "/purge <amount>",
  description: "Bulk-delete recent messages in this channel.",
  details:
    "Sweeps the newest 1–100 messages from the channel in one shot. Discord only " +
    "bulk-deletes messages under 14 days old — older ones are skipped and the " +
    "final count tells you exactly how many actually went. The confirmation prompt " +
    "is ephemeral so it can't be caught by its own purge. Requires Manage Messages.",
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk-delete recent messages in this channel.")
    .addIntegerOption((opt) =>
      opt
        .setName("amount")
        .setDescription("How many messages to delete (1-100)")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("CMD", `/purge invoked by ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}, channel ${interaction.channelId}`);

    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      log.warn("MOD", `/purge denied — ${interaction.user.id} lacks ManageMessages.`);
      await interaction.reply({ content: "You need the Manage Messages permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const amount = interaction.options.getInteger("amount", true);
    const channel = interaction.channel as TextChannel;

    if (!channel || !("bulkDelete" in channel)) {
      await interaction.reply({ content: "I can't purge messages in this type of channel.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Ephemeral: the confirmation prompt is one of the most recent
    // messages in the channel by the time it's shown, and a
    // NON-ephemeral prompt would very likely get swept up and
    // deleted by the very purge it just confirmed — silently
    // purging one fewer real message than requested. An ephemeral
    // message isn't part of the channel's real message history, so
    // it can't be caught by bulkDelete at all.
    const confirmed = await confirmAction(
      interaction,
      "🧹 Confirm Purge",
      `Delete up to **${amount}** recent message(s) in ${channel}? This can't be undone.`,
      { ephemeral: true },
    );
    if (!confirmed) {
      log.info("MOD", `/purge cancelled by ${interaction.user.id} in channel ${channel.id}.`);
      return;
    }

    try {
      // Discord's bulk delete only works on messages under 14 days old —
      // it silently skips older ones rather than erroring, so we report
      // the actual count removed rather than assuming success.
      const deleted = await channel.bulkDelete(amount, true);
      log.info("MOD", `/purge SUCCESS: ${interaction.user.id} deleted ${deleted.size}/${amount} messages in channel ${channel.id}.`);

      await interaction.followUp({
        flags: MessageFlags.Ephemeral,
        embeds: [
          successEmbed(
            `Deleted **${deleted.size}** message(s).` +
              (deleted.size < amount ? " (Some messages were too old to bulk-delete — anything over 14 days.)" : ""),
          ),
        ],
      });
    } catch (error) {
      log.error("MOD", `/purge FAILED in channel ${channel.id}`, error);
      await interaction.followUp({
        embeds: [errorEmbed(`The purge failed: ${safeErrorText(error)}.`)],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

export default command;
