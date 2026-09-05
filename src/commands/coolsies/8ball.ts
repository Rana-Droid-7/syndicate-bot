import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { UserInputError } from "../../lib/errors.js";
import { safeBoldText } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

/** Classic 8-ball response pool. */
const RESPONSES = [
  "It is certain.", "It is decidedly so.", "Without a doubt.", "Yes — definitely.",
  "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.",
  "Signs point to yes.", "Reply hazy, try again.", "Ask again later.", "Better not tell you now.",
  "Cannot predict now.", "Concentrate and ask again.", "Don't count on it.", "My reply is no.",
  "My sources say no.", "Outlook not so good.", "Very doubtful.",
] as const;

const MAX_QUESTION_LENGTH = 200;

function buildReply(question: string) {
  const answer = RESPONSES[Math.floor(Math.random() * RESPONSES.length)];
  log.debug("COOLSIES", `8ball: "${question}" -> "${answer}"`);
  return baseEmbed()
    .setTitle("🎱 The 8-Ball")
    .setDescription(`**${safeBoldText(question)}**\n\n🎱 *${answer}*`);
}

const command: Command = {
  category: "coolsies",
  surface: "both",
  usage: ">8ball <question>",
  examples: [">8ball will I win the lottery?"],
  cooldownSeconds: 5,
  data: new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the magic 8-ball a question.")
    .addStringOption((opt) =>
      opt.setName("question").setDescription("Yes/no question for the 8-ball").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    // Trim like the prefix path does — a whitespace-only question
    // would otherwise render as an empty bold line.
    const question = interaction.options.getString("question", true).trim();
    if (!question) {
      await interaction.reply({ embeds: [errorEmbed("Ask me an actual question — try `>8ball will I win the lottery?`.")], flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ embeds: [buildReply(question)] });
  },

  prefixExecute: async (message: Message, args: string[]) => {
    try {
      const question = args.join(" ").trim();
      if (!question) throw new UserInputError("Ask me a question — try `>8ball will I win the lottery?`.");
      if (question.length > MAX_QUESTION_LENGTH) throw new UserInputError(`Keep the question under ${MAX_QUESTION_LENGTH} characters.`);
      await message.reply({ embeds: [buildReply(question)] });
    } catch (error) {
      if (error instanceof UserInputError) {
        await message.reply({ embeds: [errorEmbed(error.message)] });
        return;
      }
      throw error;
    }
  },
};

export default command;
