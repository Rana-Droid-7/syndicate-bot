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
import { safeErrorText } from "../../lib/safeError.js";
import { log } from "../../core/logger.js";

const command: Command = {
  category: "moderation",
  surface: "slash-only",
  usage: "/kick <user> [reason]",
  description: "Kick a member from the server.",
  details:
    "Removes someone immediately — they can re-join with a fresh invite if one's " +
    "given, so it's the softer option between kick and ban. Confirmation-gated, " +
    "with the full hierarchy check (self/bot/owner/equal-or-higher blocked) " +
    "re-verified after the confirm click. Requires Kick Members.",
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server.")
    .addUserOption((opt) => opt.setName("target").setDescription("The member to kick").setRequired(true))
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason for the kick").setRequired(false).setMaxLength(512),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("CMD", `/kick invoked by ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}`);

    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.KickMembers)) {
      log.warn("MOD", `/kick denied — ${interaction.user.id} lacks KickMembers.`);
      await interaction.reply({ content: "You need the Kick Members permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const targetUser = interaction.options.getUser("target", true);
    const reason = interaction.options.getString("reason") ?? "No reason provided";

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
      "👢 Confirm Kick",
      `Kick **${target.user.tag}** (\`${target.id}\`)?\nReason: ${reason}`,
    );
    if (!confirmed) {
      log.info("MOD", `/kick cancelled by ${interaction.user.id} for target ${target.id}.`);
      return;
    }

    // Target AND hierarchy data were fetched BEFORE the (up to
    // 30-second) confirm wait. Re-fetch everything right before
    // acting: the target may have left, and the ACTOR's roles / the
    // BOT's role position may have changed while the dialog sat
    // open (demoted invoker, moved bot role) — re-checking against
    // stale pre-dialog data would act on expired authority.
    const freshTarget = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!freshTarget) {
      log.warn("MOD", `/kick: target ${targetUser.id} no longer in guild after confirmation.`);
      await interaction.followUp({ content: "That member left the server while this was being confirmed — nothing to kick.", flags: MessageFlags.Ephemeral });
      return;
    }
    const freshActor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const freshBot = await interaction.guild.members.fetchMe().catch(() => null);
    if (!freshActor || !freshBot) {
      await interaction.followUp({ content: "Couldn't re-verify your membership or my own — nothing was done.", flags: MessageFlags.Ephemeral });
      return;
    }
    const freshCheck = canModerate(freshActor, freshTarget, freshBot);
    if (!freshCheck.ok) {
      log.warn("MOD", `/kick: re-check after confirmation failed for target ${targetUser.id}: ${freshCheck.reason}`);
      await interaction.followUp({ content: `Can't proceed — things changed while this was being confirmed: ${freshCheck.reason}`, flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      await freshTarget.kick(reason);
      log.info("MOD", `/kick SUCCESS: ${freshActor.id} kicked ${freshTarget.id} in guild ${interaction.guild.id}. Reason: ${reason}`);
    } catch (error) {
      log.error("MOD", `/kick FAILED for target ${freshTarget.id}`, error);
      await interaction.followUp({
        embeds: [errorEmbed(`The kick failed: ${safeErrorText(error)}. Nothing was changed.`)],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // confirmAction already used up the original reply on the
    // confirmation message — report the actual result as a
    // follow-up (a new message) rather than editing that same
    // message, so the two updates can never race each other.
    await interaction.followUp({
      embeds: [
        baseEmbed()
          .setTitle("👢 Member Kicked")
          .addFields(
            { name: "User", value: `${freshTarget.user.tag} (\`${freshTarget.id}\`)`, inline: true },
            { name: "Moderator", value: `${interaction.user.tag}`, inline: true },
            { name: "Reason", value: reason, inline: false },
          ),
      ],
    });
  },
  // Slash-only: destructive moderation actions get the structured
  // input and Discord-native permission gating that prefix commands
  // can't offer as safely.
};

export default command;
