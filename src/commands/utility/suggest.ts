import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, successEmbed } from "../../lib/embeds.js";
import { ContextError, UserInputError } from "../../lib/errors.js";
import { truncate, sanitizeEcho } from "../../lib/validation.js";
import { suggestionService } from "../../services/suggestions.js";
import { log } from "../../core/logger.js";

const MAX_LENGTH = 500;

/**
 * Suggestion-specific sanitization: echo-safety (mass mentions,
 * invisible characters) plus newline collapsing so the export file
 * stays one-line-per-entry.
 */
function sanitizeSuggestion(text: string): string {
  return sanitizeEcho(text).replace(/\r?\n+/g, " ").trim();
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "suggest",
  usage: '>suggest "<your suggestion>"',
  description: "Send a suggestion straight to the bot's developer.",
  details:
    "Have an idea for the bot? Wrap it in quotes and send it — it's logged with " +
    "your name, server, and a timestamp for review, and you get a confirmation " +
    "with the entry number. Suggestions persist in the database and a human-" +
    "readable export. 500 characters max, one idea per message.",
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
    // Sanitize FIRST, truncate AFTER — sanitizeEcho EXPANDS text (each
    // @everyone/@here gains a zero-width mention-breaker), so slicing
    // the raw input first could let the sanitized result exceed the
    // DB CHECK (<= 500) and crash the insert. Mirrors remindme's
    // escape-then-truncate pattern.
    const safe = truncate(sanitizeSuggestion(content), MAX_LENGTH);
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
