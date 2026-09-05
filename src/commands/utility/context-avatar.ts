import { ApplicationCommandType, ContextMenuCommandBuilder, type UserContextMenuCommandInteraction } from "discord.js";
import type { UserContextCommand } from "../../types/command.js";
import { buildAvatarEmbed, buildAvatarButtonRow } from "./avatar.js";
import { log } from "../../core/logger.js";

const command: UserContextCommand = {
  category: "utility",
  contextMenu: true,
  description: "Grab any user's avatar at full size, straight from the right-click menu.",
  data: new ContextMenuCommandBuilder().setName("Avatar").setType(ApplicationCommandType.User),

  async execute(interaction: UserContextMenuCommandInteraction) {
    const target = interaction.targetUser;
    log.info("CMD", `context "Avatar" invoked by ${interaction.user.tag} (${interaction.user.id}) on target ${target.id}`);

    const row = await buildAvatarButtonRow(target);
    await interaction.reply({ embeds: [buildAvatarEmbed(target)], components: [row] });
  },
};

export default command;
