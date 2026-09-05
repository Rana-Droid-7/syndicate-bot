import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { UserInputError } from "../../lib/errors.js";
import { safeBoldText } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

const MAX_OPTIONS = 10;
const MAX_OPTION_LENGTH = 100;

function pick(options: string[]): string {
  return options[Math.floor(Math.random() * options.length)];
}

const command: Command = {
  category: "coolsies",
  surface: "prefix-only",
  name: "choose",
  usage: 'choose <option1> <option2> [more...]',
  description: "Can't decide? Let the bot pick between your options.",
  details:
    "Give it two or more options and it chooses one — the digital coin-flip for " +
    "decisions that have more than two sides. Wrap multi-word options in quotes " +
    "(`choose \"green curry\" pizza`). Up to 10 options, 100 characters each.",
  examples: ['choose pizza pasta "green curry"'],
  cooldownSeconds: 5,

  prefixExecute: async (message: Message, args: string[]) => {
    // args arrive QUOTE-PARSED from the dispatcher:
    //   >choose "green curry" pizza  ->  ["green curry", "pizza"]
    // Taxonomy errors propagate to the dispatcher's single rendering
    // path — identical embeds to every other command + cooldown
    // refund on input mistakes.
    const options = validateOptions(args);
    await message.reply({ embeds: [buildEmbed(options)] });
  },
};

export function validateOptions(raw: string[]): string[] {
  if (raw.length > MAX_OPTIONS) {
    throw new UserInputError(`That's ${raw.length} options — the cap is ${MAX_OPTIONS}. Drop the extras and try again.`);
  }
  const options = raw.map((o) => o.trim()).filter(Boolean);
  if (options.length < 2) {
    throw new UserInputError(`Give me at least 2 options to choose between — \`${config.prefix}choose pizza pasta\`.`, "choose <option1> <option2> [more...]");
  }
  for (const option of options) {
    if (option.length > MAX_OPTION_LENGTH) {
      throw new UserInputError(`Options must be under ${MAX_OPTION_LENGTH} characters each.`);
    }
  }
  return options;
}

function buildEmbed(options: string[]) {
  const choice = pick(options);
  log.debug("COOLSIES", `Choose: [${options.join(", ")}] -> "${choice}"`);
  return baseEmbed()
    .setTitle("🎯 Choosing...")
    .setDescription(
      `Between ${options.map((o) => `**${safeBoldText(o)}**`).join(", ")}...\n\n🎯 I choose **${safeBoldText(choice)}**!`,
    );
}

export default command;
