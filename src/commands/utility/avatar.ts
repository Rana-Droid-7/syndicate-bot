import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type User,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { mentionToId, isSnowflake } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

export function buildAvatarEmbed(user: User) {
  const url = user.displayAvatarURL({ size: 1024 });
  return baseEmbed()
    .setTitle(`${user.username}'s Avatar`)
    .setImage(url)
    .setDescription(`[Open full size](${url})`);
}

/** Link buttons under an avatar reply: full-size, plus banner when the user has one. */
export async function buildAvatarButtonRow(user: User): Promise<ActionRowBuilder<ButtonBuilder>> {
  const fetched: User | null = await user.fetch().catch(() => null);
  const bannerUrl = fetched?.bannerURL({ size: 1024 }) ?? null;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open Avatar").setStyle(ButtonStyle.Link).setURL(user.displayAvatarURL({ size: 4096 })),
  );
  if (bannerUrl) {
    row.addComponents(new ButtonBuilder().setLabel("Open Banner").setStyle(ButtonStyle.Link).setURL(bannerUrl));
  }
  return row;
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "avatar",
  usage: "avatar [@user]",
  description: "Show anyone's avatar in full size.",
  details:
    "Pulls a user's avatar at full resolution with a direct link underneath — " +
    "great for grabbing the original file. Works with mentions, bare IDs, or no " +
    "argument (yourself). The button row includes a banner link too when the " +
    "user has one.",
  cooldownSeconds: 3,

  prefixNames: ["avatar", "av", "pfp"],
  async prefixExecute(message: Message, args: string[]) {
    const mentioned = message.mentions.users.first();
    const rawArg = args[0];

    if (!mentioned && !rawArg) {
      log.info("PREFIX", `>avatar invoked by ${message.author.tag} (${message.author.id}) with no args — showing self.`);
      const row = await buildAvatarButtonRow(message.author);
      await message.reply({ embeds: [buildAvatarEmbed(message.author)], components: [row] });
      return;
    }

    const targetId = mentioned?.id ?? mentionToId(rawArg!);
    if (!isSnowflake(targetId)) {
      log.debug("PREFIX", `>avatar given invalid target: ${JSON.stringify(rawArg)}`);
      await message.reply(`\`${rawArg}\` doesn't look like a valid user mention or ID.`);
      return;
    }

    const user = await message.client.users.fetch(targetId).catch(() => null);
    log.info("PREFIX", `>avatar invoked by ${message.author.tag} (${message.author.id}) for target ${targetId} -> ${user ? "found" : "not found"}`);

    if (!user) {
      await message.reply("Couldn't find that user.");
      return;
    }

    const row = await buildAvatarButtonRow(user);
    await message.reply({ embeds: [buildAvatarEmbed(user)], components: [row] });
  },
};

export default command;
