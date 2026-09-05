import { ApplicationCommandType, ContextMenuCommandBuilder, MessageFlags, type UserContextMenuCommandInteraction } from "discord.js";
import type { UserContextCommand } from "../../types/command.js";
import { buildUserInfoEmbed } from "./userinfo.js";
import { log } from "../../core/logger.js";

const command: UserContextCommand = {
  category: "utility",
  contextMenu: true,
  description: "The full profile card for any user, one right-click away.",
  data: new ContextMenuCommandBuilder().setName("User Info").setType(ApplicationCommandType.User),

  async execute(interaction: UserContextMenuCommandInteraction) {
    const target = interaction.targetUser;
    log.info("CMD", `context "User Info" invoked by ${interaction.user.tag} (${interaction.user.id}) on target ${target.id}`);

    if (!interaction.guild) {
      await interaction.reply({ content: "This only works in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
    if (!member) {
      await interaction.reply({ content: "Couldn't find that member in this server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const { embed } = await buildUserInfoEmbed(member);
    await interaction.reply({ embeds: [embed] });
  },
};

export default command;
