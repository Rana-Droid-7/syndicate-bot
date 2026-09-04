import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed, successEmbed } from "../../lib/embeds.js";
import { warningService } from "../../services/warnings.js";
import { canModerate } from "../../lib/permissions.js";
import { confirmAction } from "../../lib/confirm.js";
import { log } from "../../core/logger.js";

const command: Command = {
  category: "moderation",
  surface: "slash-only",
  usage: "/warn add|list|clear <user> [reason]",
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Manage warnings for a member.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a warning to a member.")
        .addUserOption((opt) => opt.setName("target").setDescription("The member to warn").setRequired(true))
        .addStringOption((opt) =>
          opt.setName("reason").setDescription("Reason for the warning").setRequired(true).setMaxLength(500),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("list")
        .setDescription("List a member's warnings.")
        .addUserOption((opt) => opt.setName("target").setDescription("The member to check").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Clear all warnings for a member.")
        .addUserOption((opt) => opt.setName("target").setDescription("The member to clear").setRequired(true)),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ModerateMembers)) {
      log.warn("MOD", `/warn denied — ${interaction.user.id} lacks ModerateMembers.`);
      await interaction.reply({ content: "You need the Timeout Members permission to manage warnings.", flags: MessageFlags.Ephemeral });
      return;
    }

    const sub = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser("target", true);
    log.info("CMD", `/warn ${sub} invoked by ${interaction.user.tag} (${interaction.user.id}) for target ${targetUser.id}`);

    if (sub === "add") {
      const reason = interaction.options.getString("reason", true);

      // Warnings are a moderation action exactly like kick/ban/timeout,
      // so they run the same hierarchy gate: the target must be a real
      // member, and canModerate() blocks self/bot/owner/equal-or-higher-
      // role targeting and a too-low bot role. Previously /warn add ran
      // none of these checks.
      const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
      if (!target) {
        await interaction.reply({ content: "Couldn't find that member in this server.", flags: MessageFlags.Ephemeral });
        return;
      }
      const actor = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!actor) {
        await interaction.reply({ content: "Couldn't resolve your own membership in this server.", flags: MessageFlags.Ephemeral });
        return;
      }
      const botMember = await interaction.guild.members.fetchMe();
      const check = canModerate(actor, target, botMember);
      if (!check.ok) {
        log.warn("MOD", `/warn add denied by hierarchy check: ${interaction.user.id} -> ${targetUser.id}: ${check.reason}`);
        await interaction.reply({ content: check.reason!, flags: MessageFlags.Ephemeral });
        return;
      }

      const count = warningService.add(interaction.guild.id, targetUser.id, interaction.user.id, reason);

      await interaction.reply({
        embeds: [
          baseEmbed()
            .setTitle("⚠️ Warning Added")
            .addFields(
              { name: "User", value: `${targetUser.tag} (\`${targetUser.id}\`)`, inline: true },
              { name: "Moderator", value: `${interaction.user.tag}`, inline: true },
              { name: "Total Warnings", value: `${count}`, inline: true },
              { name: "Reason", value: reason, inline: false },
            )
            .setFooter({ text: "Warnings are in-memory in this beta — lost if the bot restarts." }),
        ],
      });
      return;
    }

    if (sub === "list") {
      const warnings = warningService.activeFor(interaction.guild.id, targetUser.id);

      if (warnings.length === 0) {
        await interaction.reply({
          embeds: [baseEmbed().setDescription(`**${targetUser.tag}** has no warnings.`)],
        });
        return;
      }

      // Reasons can be up to 500 chars each and the store caps at 25
      // per user, so the raw list can hit ~13,500 chars — way past
      // Discord's 4096-char embed description limit. formatWarningsList
      // truncates reasons and drops the oldest entries if needed.
      const list = warningService.formatList(warnings);

      await interaction.reply({
        embeds: [
          baseEmbed()
            .setTitle(`⚠️ Warnings for ${targetUser.tag}`)
            .setDescription(list.description)
            .setFooter({
              text:
                list.totalCount > list.shownCount
                  ? `${list.totalCount} total warning(s) — ${list.shownCount} most recent shown`
                  : `${list.totalCount} total warning(s)`,
            }),
        ],
      });
      return;
    }

    if (sub === "clear") {
      const existing = warningService.activeFor(interaction.guild.id, targetUser.id);
      if (existing.length === 0) {
        await interaction.reply({
          embeds: [baseEmbed().setDescription(`**${targetUser.tag}** had no warnings to clear.`)],
        });
        return;
      }

      const confirmed = await confirmAction(
        interaction,
        "⚠️ Confirm Clear Warnings",
        `Clear all **${existing.length}** warning(s) for **${targetUser.tag}**? This can't be undone.`,
      );
      if (!confirmed) {
        log.info("MOD", `/warn clear cancelled by ${interaction.user.id} for target ${targetUser.id}.`);
        return;
      }

      const count = warningService.clearActive(interaction.guild.id, targetUser.id);
      await interaction.followUp({
        embeds: [successEmbed(`Cleared **${count}** warning(s) for **${targetUser.tag}**.`)],
      });
    }
  },
};

export default command;
