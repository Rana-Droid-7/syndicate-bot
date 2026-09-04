import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, successEmbed } from "../../lib/embeds.js";
import { ContextError, UserInputError } from "../../lib/errors.js";
import { sanitizeSuggestion } from "./suggest-utils.js";
import { suggestionService } from "../../services/suggestions.js";
import { log } from "../../core/logger.js";

const MAX_LENGTH = 500;

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "suggest",
  usage: '>suggest "<your suggestion>"',
  examples: ['>suggest "add a music command"'],
  cooldownSeconds: 10,
  prefixNames: ["suggest", "suggestion"],

  prefixExecute: async (message: Message, args: string[]) => {
    if (!message.guild) throw new ContextError("Suggestions only work in a server.");

    // args arrive quote-parsed: >suggest "add music" -> ["add music"]
    const content = (args.join(" ") || "").trim();

    if (!content) {
      throw new UserInputError('Wrap your suggestion in double quotes — `>suggest "add a music command"`.', '>suggest "<your suggestion>"');
    }
    if (content.length > MAX_LENGTH) {
      throw new UserInputError(`Suggestions cap at ${MAX_LENGTH} characters.`);
    }
    const safe = sanitizeSuggestion(content);
    if (!safe) throw new UserInputError("Your suggestion can't be empty.");

    const id = await suggestionService.add(
      message.guild.id,
      message.author.id,
      message.author.tag,
      message.guild.name,
      safe,
    );

    await message.reply({
      embeds: [
        baseEmbed()
          .setTitle("💡 Suggestion Received")
          .setDescription(`Thanks, ${message.author}! Your suggestion has been logged for review:\n\n> ${safe}`)
          .setFooter({ text: `Entry #${id} — saved with a timestamp for the server owner to review.` }),
      ],
    });
  },
};

export default command;
