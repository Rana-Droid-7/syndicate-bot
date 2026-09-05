import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { UserInputError } from "../../lib/errors.js";
import { mentionToId, isSnowflake } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

async function replyWithBanner(
  userId: string,
  client: import("discord.js").Client,
  respond: (payload: { content?: string; embeds?: import("discord.js").EmbedBuilder[] }) => Promise<unknown>,
) {
  const user = await client.users.fetch(userId, { force: true }).catch(() => null);
  log.debug("BANNER", `Fetched user ${userId} (force) -> ${user ? "found" : "not found"}`);

  if (!user) {
    await respond({ content: "Couldn't find that user." });
    return;
  }

  const bannerUrl = user.bannerURL({ size: 1024 });

  if (!bannerUrl) {
    await respond({
      embeds: [baseEmbed().setDescription(`**${user.username}** doesn't have a banner set.`)],
    });
    return;
  }

  await respond({
    embeds: [
      baseEmbed()
        .setTitle(`${user.username}'s Banner`)
        .setImage(bannerUrl)
        .setDescription(`[Open full size](${bannerUrl})`),
    ],
  });
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "banner",
  usage: "banner [@user]",
  description: "Show a user's profile banner, if they have one.",
  details:
    "Fetches the profile banner behind someone's avatar at full size. Not " +
    "everyone has one — if they don't, the bot says so plainly. Works with " +
    "mentions, bare IDs, or yourself.",
  cooldownSeconds: 3,

  prefixNames: ["banner"],
  async prefixExecute(message: Message, args: string[]) {
    const mentioned = message.mentions.users.first();
    const rawArg = args[0];

    if (!mentioned && !rawArg) {
      log.info("PREFIX", `>banner invoked by ${message.author.tag} (${message.author.id}) with no args — showing self.`);
      await replyWithBanner(message.author.id, message.client, (p) => message.reply(p));
      return;
    }

    const targetId = mentioned?.id ?? mentionToId(rawArg!);
    if (!isSnowflake(targetId)) {
      throw new UserInputError(`\`${rawArg}\` doesn't look like a valid user mention or ID.`, "banner [@user]");
    }

    log.info("PREFIX", `>banner invoked by ${message.author.tag} (${message.author.id}) for target ${targetId}`);
    await replyWithBanner(targetId, message.client, (p) => message.reply(p));
  },
};

export default command;
