import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed, successEmbed } from "../../lib/embeds.js";
import { isAdmin } from "../../lib/permissions.js";
import { log } from "../../core/logger.js";

const command: Command = {
  category: "admin",
  surface: "slash-only",
  usage: "/setnick [nickname]",
  data: new SlashCommandBuilder()
    .setName("setnick")
    .setDescription("Change Syndicate Bot's nickname in this server. (Admin only)")
    .addStringOption((opt) =>
      opt.setName("nickname").setDescription("New nickname (leave blank to reset)").setRequired(false).setMaxLength(32),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "This command only works in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member || !isAdmin(member)) {
      log.warn("ADMIN", `/setnick denied — ${interaction.user.id} lacks Administrator.`);
      await interaction.reply({ content: "You need Administrator permission to use this.", flags: MessageFlags.Ephemeral });
      return;
    }

    const nickname = interaction.options.getString("nickname");
    log.info("CMD", `/setnick invoked by ${interaction.user.tag} (${interaction.user.id}): ${JSON.stringify(nickname)}`);
    const botMember = await interaction.guild.members.fetchMe();

    try {
      await botMember.setNickname(nickname);
      log.info("ADMIN", `/setnick SUCCESS in guild ${interaction.guild.id}: ${JSON.stringify(nickname)}`);
    } catch (error) {
      log.error("ADMIN", `/setnick FAILED in guild ${interaction.guild.id}`, error);
      await interaction.reply({
        embeds: [errorEmbed("I couldn't change my nickname — check that my role has permission to manage my own nickname.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [
        successEmbed(
          nickname ? `Nickname changed to **${nickname}** in this server.` : "Nickname reset to default in this server.",
        ),
      ],
    });
  },
};

export default command;
