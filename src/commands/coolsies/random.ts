import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { UserInputError } from "../../lib/errors.js";
import { parseIntInRange } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

const MIN = -1_000_000;
const MAX = 1_000_000;

function draw(min: number, max: number): number {
  // Inclusive on both ends: integer in [min, max].
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildEmbed(min: number, max: number) {
  const value = draw(min, max);
  log.debug("COOLSIES", `Random [${min}, ${max}] -> ${value}`);
  return baseEmbed().setTitle("🎯 Random Number").setDescription(`Between **${min}** and **${max}**:\n\n🎯 **${value}**`);
}

const command: Command = {
  category: "coolsies",
  surface: "prefix-only",
  name: "random",
  usage: "random <min> <max>",
  description: "A random number between two bounds.",
  details:
    "Fair draw from any range you give — both ends included. Bounds between " +
    "-1,000,000 and 1,000,000. Useful for picks, giveaways, and settling \"pick " +
    "a number between 1 and 100\" on the spot.",
  examples: ["random 1 100"],
  cooldownSeconds: 3,

  prefixExecute: async (message: Message, args: string[]) => {
    // Taxonomy errors propagate to the dispatcher's single rendering
    // path — identical embeds everywhere + cooldown refund on input
    // mistakes.
    if (args.length < 2) throw new UserInputError(`Give me two numbers — \`${config.prefix}random 1 100\`.`, "random <min> <max>");
    const min = parseIntInRange(args[0], MIN, MAX, "minimum");
    const max = parseIntInRange(args[1], MIN, MAX, "maximum");
    validate(min, max);
    await message.reply({ embeds: [buildEmbed(min, max)] });
  },
};

function validate(min: number, max: number): void {
  if (min > max) throw new UserInputError("The minimum can't be bigger than the maximum.");
}

export default command;
