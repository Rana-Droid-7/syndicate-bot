import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { buildInviteUrl } from "../../lib/invite.js";
import { config } from "../../core/config.js";
import { log } from "../../core/logger.js";

function buildInvitePayload() {
  const inviteUrl = buildInviteUrl();

  const embed = baseEmbed()
    .setTitle(`✨ Invite ${config.botName}`)
    .setDescription(
      `Take ${config.botName} to your own server.\n\n` +
        `The invite link requests exactly the permissions the commands need — nothing more.`,
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(`Invite ${config.botName}`).setEmoji("➕").setStyle(ButtonStyle.Link).setURL(inviteUrl),
  );

  return { embeds: [embed], components: [row] };
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "invite",
  usage: "invite",
  description: "Get the bot's invite link.",
  details:
    "A one-click invite that requests exactly the permissions the bot's commands " +
    "need — nothing more. Take it to any server where you have Manage Server.",
  cooldownSeconds: 5,

  prefixNames: ["invite"],
  async prefixExecute(message: Message) {
    log.info("PREFIX", `>invite invoked by ${message.author.tag} (${message.author.id})`);
    await message.reply(buildInvitePayload());
  },
};

export default command;
