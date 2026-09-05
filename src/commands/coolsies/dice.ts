import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

/** Uniform 1-6: floor(random*6)+1 — random() ∈ [0,1) so max is 6, never 0, never 7. */
export function rollDie(): number {
  return Math.floor(Math.random() * 6) + 1;
}

function buildEmbed(): { embed: ReturnType<typeof baseEmbed>; face: number } {
  const face = rollDie();
  log.debug("COOLSIES", `Dice rolled: ${face}`);
  return {
    face,
    embed: baseEmbed().setTitle("🎲 Rolling the die...").setDescription(`🎲 You rolled **${face}**!`),
  };
}

const command: Command = {
  category: "coolsies",
  surface: "prefix-only",
  name: "dice",
  usage: "dice",
  description: "Roll a six-sided die.",
  details:
    "One clean d6 roll — 1 through 6, each face equally likely. For dice notation " +
    "with counts, sides, and modifiers, see `roll`.",
  examples: ["dice"],
  cooldownSeconds: 3,

  prefixExecute: async (message: Message) => {
    await message.reply({ embeds: [buildEmbed().embed] });
  },
};

export default command;
