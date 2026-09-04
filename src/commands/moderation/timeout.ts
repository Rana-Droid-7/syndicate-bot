import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { canModerate } from "../../lib/permissions.js";
import { discordTimestamp } from "../../lib/format.js";
import { confirmAction } from "../../lib/confirm.js";
import { log } from "../../core/logger.js";

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord's own cap: 28 days

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseDuration(input: string): number | null {
  const match = input.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  return value * DURATION_UNITS[unit];
}

const command: Command = {
  category: "moderation",
  surface: "slash-only",
  usage: "/timeout <user> <duration> [reason]",
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Time out a member (temporarily restrict them from sending messages).")
    .addUserOption((opt) => opt.setName("target").setDescription("The member to time out").setRequired(true))
    .addStringOption((opt) =>
      opt.setName("duration").setDescription("e.g. 10m, 1h, 1d (max 28d)").setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason for the timeout").setRequired(false).setMaxLength(512),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("CMD", `/timeout invoked by ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}`);

    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
      log.warn("MOD", `/timeout denied — ${interaction.user.id} lacks ModerateMembers.`);
      await interaction.reply({ content: "You need the Timeout Members permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const targetUser = interaction.options.getUser("target", true);
    const durationInput = interaction.options.getString("duration", true);
    const reason = interaction.options.getString("reason") ?? "No reason provided";

    const durationMs = parseDuration(durationInput);
    if (!durationMs || durationMs <= 0) {
      await interaction.reply({
        content: `Invalid duration \`${durationInput}\`. Use a number plus s/m/h/d, e.g. \`10m\`, \`1h\`, \`1d\`.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (durationMs > MAX_TIMEOUT_MS) {
      await interaction.reply({ content: "Timeouts can't exceed 28 days (Discord's own limit).", flags: MessageFlags.Ephemeral });
      return;
    }

    const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!actor) {
      await interaction.reply({ content: "Couldn't resolve your own membership in this server.", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const botMember = await interaction.guild.members.fetchMe();

    if (!target) {
      await interaction.reply({ content: "Couldn't find that member in this server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const check = canModerate(actor, target, botMember);
    if (!check.ok) {
      await interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
      return;
    }

    const confirmed = await confirmAction(
      interaction,
      "🔇 Confirm Timeout",
      `Time out **${target.user.tag}** (\`${target.id}\`) for **${durationInput}**?\nReason: ${reason}`,
    );
    if (!confirmed) {
      log.info("MOD", `/timeout cancelled by ${interaction.user.id} for target ${target.id}.`);
      return;
    }

    const freshTarget = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!freshTarget) {
      log.warn("MOD", `/timeout: target ${targetUser.id} no longer in guild after confirmation.`);
      await interaction.followUp({ content: "That member left the server while this was being confirmed — nothing to time out.", flags: MessageFlags.Ephemeral });
      return;
    }
    const freshCheck = canModerate(actor, freshTarget, botMember);
    if (!freshCheck.ok) {
      log.warn("MOD", `/timeout: re-check after confirmation failed for target ${targetUser.id}: ${freshCheck.reason}`);
      await interaction.followUp({ content: `Can't proceed — things changed while this was being confirmed: ${freshCheck.reason}`, flags: MessageFlags.Ephemeral });
      return;
    }

    let untilUnix: number;
    try {
      await freshTarget.timeout(durationMs, reason);
      // Computed AFTER the action succeeds, not before, so the
      // expiry shown reflects when the timeout actually started.
      untilUnix = Math.floor((Date.now() + durationMs) / 1000);
      log.info("MOD", `/timeout SUCCESS: ${actor.id} timed out ${freshTarget.id} for ${durationInput} in guild ${interaction.guild.id}. Reason: ${reason}`);
    } catch (error) {
      log.error("MOD", `/timeout FAILED for target ${freshTarget.id}`, error);
      await interaction.followUp({
        embeds: [errorEmbed(`The timeout failed: ${error instanceof Error ? error.message : "unknown error"}. Nothing was changed.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.followUp({
      embeds: [
        baseEmbed()
          .setTitle("🔇 Member Timed Out")
          .addFields(
            { name: "User", value: `${freshTarget.user.tag} (\`${freshTarget.id}\`)`, inline: true },
            { name: "Moderator", value: `${interaction.user.tag}`, inline: true },
            { name: "Expires", value: `${discordTimestamp(untilUnix, "F")} (${discordTimestamp(untilUnix, "R")})`, inline: false },
            { name: "Reason", value: reason, inline: false },
          ),
      ],
    });
  },
};

export default command;
