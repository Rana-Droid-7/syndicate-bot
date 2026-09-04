import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { canModerate } from "../../lib/permissions.js";
import { confirmAction } from "../../lib/confirm.js";
import { log } from "../../core/logger.js";

const command: Command = {
  category: "moderation",
  surface: "slash-only",
  usage: "/ban <user> [reason] [delete_days]",
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server.")
    .addUserOption((opt) => opt.setName("target").setDescription("The member to ban").setRequired(true))
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason for the ban").setRequired(false).setMaxLength(512),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("delete_days")
        .setDescription("Delete this many days of their recent messages (0-7)")
        .setMinValue(0)
        .setMaxValue(7)
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("CMD", `/ban invoked by ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}`);

    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers)) {
      log.warn("MOD", `/ban denied — ${interaction.user.id} lacks BanMembers.`);
      await interaction.reply({ content: "You need the Ban Members permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const targetUser = interaction.options.getUser("target", true);
    const reason = interaction.options.getString("reason") ?? "No reason provided";
    const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

    const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!actor) {
      await interaction.reply({ content: "Couldn't resolve your own membership in this server.", flags: MessageFlags.Ephemeral });
      return;
    }
    const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const botMember = await interaction.guild.members.fetchMe();

    if (!target) {
      // Not currently in the server (e.g. banning by ID after they
      // left) — still confirm, since a ban is a ban either way.
      const confirmed = await confirmAction(
        interaction,
        "🔨 Confirm Ban",
        `Ban **${targetUser.tag}** (\`${targetUser.id}\`) by ID? They're not currently in this server.\nReason: ${reason}`,
      );
      if (!confirmed) {
        log.info("MOD", `/ban (by-ID) cancelled by ${interaction.user.id} for target ${targetUser.id}.`);
        return;
      }

      try {
        await interaction.guild.bans.create(targetUser.id, {
          reason,
          deleteMessageSeconds: deleteDays * 86400,
        });
        log.info("MOD", `/ban SUCCESS (by-ID): ${actor.id} banned ${targetUser.id} in guild ${interaction.guild.id}. Reason: ${reason}`);
      } catch (error) {
        log.error("MOD", `/ban (by-ID) FAILED for target ${targetUser.id}`, error);
        await interaction.followUp({
          embeds: [errorEmbed(`The ban failed: ${error instanceof Error ? error.message : "unknown error"}. Nothing was changed.`)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.followUp({
        embeds: [
          baseEmbed()
            .setTitle("🔨 User Banned")
            .setDescription("This user wasn't currently in the server, but has been banned by ID.")
            .addFields(
              { name: "User", value: `${targetUser.tag} (\`${targetUser.id}\`)`, inline: true },
              { name: "Moderator", value: `${interaction.user.tag}`, inline: true },
              { name: "Reason", value: reason, inline: false },
            ),
        ],
      });
      return;
    }

    const check = canModerate(actor, target, botMember);
    if (!check.ok) {
      await interaction.reply({ content: check.reason, flags: MessageFlags.Ephemeral });
      return;
    }

    const confirmed = await confirmAction(
      interaction,
      "🔨 Confirm Ban",
      `Ban **${target.user.tag}** (\`${target.id}\`)?\nReason: ${reason}${deleteDays > 0 ? `\nWill also delete their last ${deleteDays} day(s) of messages.` : ""}`,
    );
    if (!confirmed) {
      log.info("MOD", `/ban cancelled by ${interaction.user.id} for target ${target.id}.`);
      return;
    }

    // Re-validate against fresh data — see kick.ts for why.
    const freshTarget = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (freshTarget) {
      const freshCheck = canModerate(actor, freshTarget, botMember);
      if (!freshCheck.ok) {
        log.warn("MOD", `/ban: re-check after confirmation failed for target ${targetUser.id}: ${freshCheck.reason}`);
        await interaction.followUp({ content: `Can't proceed — things changed while this was being confirmed: ${freshCheck.reason}`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    // If freshTarget is null here, they left the server during
    // confirmation — banning by ID still works and is still what
    // the moderator asked for, so we proceed with targetUser.id.

    try {
      await interaction.guild.members.ban(targetUser.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
      log.info("MOD", `/ban SUCCESS: ${actor.id} banned ${targetUser.id} in guild ${interaction.guild.id}. Reason: ${reason}`);
    } catch (error) {
      log.error("MOD", `/ban FAILED for target ${targetUser.id}`, error);
      await interaction.followUp({
        embeds: [errorEmbed(`The ban failed: ${error instanceof Error ? error.message : "unknown error"}. Nothing was changed.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.followUp({
      embeds: [
        baseEmbed()
          .setTitle("🔨 Member Banned")
          .addFields(
            { name: "User", value: `${targetUser.tag} (\`${targetUser.id}\`)`, inline: true },
            { name: "Moderator", value: `${interaction.user.tag}`, inline: true },
            { name: "Reason", value: reason, inline: false },
          ),
      ],
    });
  },
};

export default command;
