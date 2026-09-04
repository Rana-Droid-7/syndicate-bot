import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { UserInputError } from "../../lib/errors.js";
import { parseQuotedArgs, safeBoldText } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

const MAX_OPTIONS = 10;
const MAX_OPTION_LENGTH = 100;

function pick(options: string[]): string {
  return options[Math.floor(Math.random() * options.length)];
}

const command: Command = {
  category: "coolsies",
  surface: "both",
  usage: ">choose <option1> <option2> [more...]",
  examples: ['>choose pizza pasta "green curry"', ">choose left right"],
  cooldownSeconds: 5,
  data: new SlashCommandBuilder()
    .setName("choose")
    .setDescription("Let the bot choose between options.")
    .addStringOption((o) => o.setName("options").setDescription('Options, e.g. "pizza pasta sushi" (quotes around multi-word ones)').setRequired(true).setMaxLength(500)),

  async execute(interaction: ChatInputCommandInteraction) {
    // Slash delivers one raw string — parse it here.
    const raw = interaction.options.getString("options", true);
    const { args } = parseQuotedArgs(raw);
    try {
      const options = validateOptions(args);
      await interaction.reply({ embeds: [buildEmbed(options)] });
    } catch (error) {
      if (error instanceof UserInputError) {
        await interaction.reply({ embeds: [errorEmbed(error.message)], flags: MessageFlags.Ephemeral });
        return;
      }
      throw error;
    }
  },

  prefixExecute: async (message: Message, args: string[]) => {
    // Prefix args arrive QUOTE-PARSED from the dispatcher:
    //   >choose "green curry" pizza  ->  ["green curry", "pizza"]
    try {
      const options = validateOptions(args);
      await message.reply({ embeds: [buildEmbed(options)] });
    } catch (error) {
      if (error instanceof UserInputError) {
        await message.reply({ embeds: [errorEmbed(error.message)] });
        return;
      }
      throw error;
    }
  },
};

function validateOptions(raw: string[]): string[] {
  const options = raw.map((o) => o.trim()).filter(Boolean).slice(0, MAX_OPTIONS);
  if (options.length < 2) {
    throw new UserInputError("Give me at least 2 options to choose between — `>choose pizza pasta`.", ">choose <option1> <option2> [more...]");
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
