import { type Message } from "discord.js";
import * as chrono from "chrono-node";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed } from "../../lib/embeds.js";
import { ContextError, UserInputError } from "../../lib/errors.js";
import { escapeInlineCode, safeBoldText, truncate } from "../../lib/validation.js";
import { reminderService } from "../../services/reminders.js";
import { discordTimestamp } from "../../lib/format.js";
import { log } from "../../core/logger.js";

const MAX_DELAY_MS = 30 * 24 * 60 * 60 * 1000; // 30-day cap
// Matches the DB CHECK constraint. Truncation happens AFTER escaping
// (safeBoldText expands `**`/`__` with zero-width chars) — slicing the
// raw text first would let the escaped result exceed the constraint
// and crash the insert with a CHECK violation.
const MAX_TEXT_LENGTH = 300;

function parseAndValidate(timeInput: string): { date: Date; delayMs: number } {
  const parsedDate = chrono.parseDate(timeInput, new Date(), { forwardDate: true });
  if (!parsedDate) {
    throw new UserInputError(
      `I couldn't understand \`${escapeInlineCode(timeInput)}\` as a time — try \`in 2 hours\` or \`tomorrow 9am\`.`,
      `${config.prefix}remindme "<time>" <what>`,
    );
  }
  const delayMs = parsedDate.getTime() - Date.now();
  if (delayMs <= 0) throw new UserInputError("That time is in the past — give me a time in the future.");
  // Sub-second parses ("in 0.0001 seconds") would fire the timer
  // before the confirmation reply even lands — pointless. Anything
  // under a second rounds up to one.
  if (delayMs < 1_000) {
    return { date: new Date(Date.now() + 1_000), delayMs: 1_000 };
  }
  if (delayMs > MAX_DELAY_MS) {
    throw new UserInputError("That's more than 30 days out — reminders cap at 30 days.");
  }
  return { date: parsedDate, delayMs };
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "remindme",
  usage: 'remindme "<time>" <what to remember>',
  description: "Set a reminder — natural language time, delivered here.",
  details:
    "Tell it when in quotes and what after: the time accepts natural language " +
    "via chrono-node (\"in 20 minutes\", \"tomorrow 9am\", \"dec 25 3pm\"), and the " +
    "bot pings you in the same channel when it's due. Reminders are persistent — " +
    "they survive restarts and crashes, and anything that came due while the bot " +
    "was down is delivered on next boot. Cap: 30 days out, 300 characters of text, " +
    "25 pending reminders at a time.",
  examples: ['remindme "in 2 hours" stretch my legs', 'remindme "tomorrow 9am" team meeting'],
  cooldownSeconds: 5,
  prefixNames: ["remindme", "remind"],

  prefixExecute: async (message: Message, args: string[]) => {
    if (!message.guild) throw new ContextError("Reminders only work in a server.");
    if (!message.channel.isTextBased() || !("send" in message.channel)) {
      throw new ContextError("I can't send reminders in this type of channel.");
    }

    // args arrive quote-parsed from the dispatcher:
    // >remindme "in 20 minutes" walk the dog
    //   -> ["in 20 minutes", "walk", "the", "dog"]
    if (args.length < 2) {
      throw new UserInputError(`Give me a quoted time and a reminder — \`${config.prefix}remindme "in 20 minutes" walk the dog\`.`, 'remindme "<time>" <what>');
    }

    const timeInput = args[0];
    const text = args.slice(1).join(" ");
    if (!text) throw new UserInputError("Tell me what to remind you about.");

    const { date } = parseAndValidate(timeInput);
    // Escape first, truncate after — see MAX_TEXT_LENGTH note above.
    const safeText = truncate(safeBoldText(text), MAX_TEXT_LENGTH);
    // Escaping strips nothing but the input could still be entirely
    // invisible characters — an empty stored text violates the DB
    // CHECK (BETWEEN 1 AND 300) and crashes the insert. The
    // dispatcher's UserInputError path (usage + no cooldown burn)
    // handles the rejection cleanly.
    if (!safeText.trim()) {
      throw new UserInputError("Tell me what to remind you about — that text is all invisible characters.");
    }
    const dueUnixMs = date.getTime();

    await reminderService.create(
      message.client,
      message.guild.id,
      message.channelId,
      message.author.id,
      safeText,
      dueUnixMs,
    );

    const unixSeconds = Math.floor(dueUnixMs / 1000);
    log.info("TIMER", `Reminder set by ${message.author.id} in channel ${message.channelId}, due ${unixSeconds}: "${safeText}"`);
    await message.reply({
      embeds: [
        baseEmbed()
          .setTitle("⏰ Reminder Set")
          .setDescription(
            `I'll remind you here: **${safeText}**\n\n${discordTimestamp(unixSeconds, "F")} (${discordTimestamp(unixSeconds, "R")})`,
          )
          .setFooter({ text: "Reminders are persistent — they survive restarts." }),
      ],
    });
  },
};

export default command;
