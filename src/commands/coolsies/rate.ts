import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { UserInputError } from "../../lib/errors.js";
import { escapeInlineCode, mentionToId, isSnowflake } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

/** Rates out of 10 — biased slightly toward kindness at the bottom end. */
function drawRating(): number {
  return Math.floor(Math.random() * 11); // 0-10
}

const VERDICTS: string[] = [
  "a solid vibe", "surprisingly great", "doing their best", "certified legend material",
  "mysteriously mid", "objectively iconic", "chaotic but lovable", "an acquired taste",
];

function buildEmbed(targetMention: string, targetName: string) {
  const rating = drawRating();
  const verdict = VERDICTS[Math.floor(Math.random() * VERDICTS.length)];
  log.debug("COOLSIES", `Rate: ${targetName} -> ${rating}/10`);
  const stars = "⭐".repeat(rating) || "—";
  return baseEmbed()
    .setTitle("📊 Rate")
    .setDescription(`I rate ${targetMention} **${rating}/10**\n${stars}\n\n_Verdict: ${verdict}._`);
}

const command: Command = {
  category: "coolsies",
  surface: "prefix-only",
  name: "rate",
  usage: "rate [@user]",
  description: "Rate anything (or anyone) out of 10 — purely for fun.",
  details:
    "Mention someone (or yourself) and the bot hands out a score out of 10 with " +
    "a matching star row and a completely scientific verdict. It's random every " +
    "time — don't take it personally. Works with mentions or bare user IDs.",
  examples: ["rate @friend"],
  cooldownSeconds: 5,

  prefixExecute: async (message: Message, args: string[]) => {
    if (!message.guild) return;

    const mentioned = message.mentions.users.first();
    if (!mentioned && args[0]) {
      const bare = mentionToId(args[0]);
      if (!isSnowflake(bare)) {
        throw new UserInputError(
          `\`${escapeInlineCode(args[0])}\` doesn't look like a valid user mention or ID.`,
          "rate [@user]",
        );
      }
      // A bare (un-cached) ID is valid input — try to resolve it so we
      // rate the person asked about, never silently fall back to self.
      const resolved = await message.client.users.fetch(bare).catch(() => null);
      if (!resolved) {
        await message.reply({ embeds: [errorEmbed("Couldn't find that user.")] });
        return;
      }
      await message.reply({ embeds: [buildEmbed(resolved.toString(), resolved.username)] });
      return;
    }

    const target = mentioned ?? message.author;
    await message.reply({ embeds: [buildEmbed(target.toString(), target.username)] });
  },
};

export default command;
