import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { discordTimestamp } from "../../lib/format.js";
import { UserInputError } from "../../lib/errors.js";
import { sanitizeEchoOrReject } from "../../lib/validation.js";

import { log } from "../../core/logger.js";

const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 60;
const MAX_QUESTION_LENGTH = 150;
const MAX_OPTION_LENGTH = 80;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const BAR_LENGTH = 12;
const BUTTONS_PER_ROW = 5;

function buildBar(count: number, total: number): string {
  if (total === 0) return "░".repeat(BAR_LENGTH);
  const filled = Math.round((count / total) * BAR_LENGTH);
  return "█".repeat(filled) + "░".repeat(BAR_LENGTH - filled);
}

function buildResultsEmbed(question: string, options: string[], votes: Map<string, number>, ended: boolean, endUnix: number) {
  const counts = options.map((_, i) => [...votes.values()].filter((v) => v === i).length);
  const total = counts.reduce((a, b) => a + b, 0);

  const lines = options.map((opt, i) => {
    const count = counts[i];
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `${NUMBER_EMOJI[i]} **${opt}**\n${buildBar(count, total)} ${count} vote${count === 1 ? "" : "s"} (${pct}%)`;
  });

  return baseEmbed()
    .setTitle(`📊 ${question}`)
    .setDescription(lines.join("\n\n"))
    .setFooter({
      text: ended
        ? `Poll closed • ${total} total vote(s)`
        : `Vote below • closes ${discordTimestamp(endUnix, "R")} • ${total} vote(s) so far`,
    });
}

function chunkRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
  }
  return rows;
}

/**
 * Parses poll arguments. Two shapes accepted:
 *   poll "question" "opt1" "opt2" ["opt3"...] [minutes]
 *     (quoted — multi-word question and options, all clean)
 *   poll question opt1 opt2 [minutes]
 *     (unquoted — each whitespace token is one option; single-word
 *     options only, but fast to type)
 * The optional trailing bare integer is always the duration.
 */
export function parsePollArgs(args: string[]): { question: string; options: string[]; minutes: number } {
  const rest = [...args];

  // Trailing bare integer = duration (default 5, 1-60).
  let minutes = 5;
  const last = rest[rest.length - 1];
  if (rest.length > 2 && last !== undefined && /^\d+$/.test(last)) {
    const parsed = Number(last);
    if (!Number.isInteger(parsed) || parsed < MIN_POLL_MINUTES || parsed > MAX_POLL_MINUTES) {
      throw new UserInputError(`Duration must be between ${MIN_POLL_MINUTES} and ${MAX_POLL_MINUTES} minutes.`, 'poll "<question>" "<option 1>" "<option 2>" [more options] [minutes]');
    }
    minutes = parsed;
    rest.pop();
  }

  const question = (rest.shift() ?? "").trim();
  if (!question) {
    throw new UserInputError("Give me a question and at least two options.", 'poll "<question>" "<option 1>" "<option 2>" [more options] [minutes]');
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new UserInputError(`Keep the question under ${MAX_QUESTION_LENGTH} characters.`);
  }

  const options = rest.map((o) => o.trim()).filter(Boolean);
  if (options.length < MIN_OPTIONS) {
    throw new UserInputError(`Give me at least ${MIN_OPTIONS} options to vote between.`, 'poll "<question>" "<option 1>" "<option 2>" [more options] [minutes]');
  }
  if (options.length > MAX_OPTIONS) {
    throw new UserInputError(`Max ${MAX_OPTIONS} options (got ${options.length}).`);
  }
  for (const option of options) {
    if (option.length > MAX_OPTION_LENGTH) {
      throw new UserInputError(`Options must be under ${MAX_OPTION_LENGTH} characters each.`);
    }
  }

  return { question, options, minutes };
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "poll",
  usage: 'poll "<question>" "<option 1>" "<option 2>" [more options] [minutes]',
  description: "Create a live button poll with a results bar.",
  details:
    "Ask anything with 2–10 options: each option becomes a numbered button, and " +
    "votes update a live bar chart on the message. One vote per person (latest " +
    "click counts), runs 1–60 minutes (default 5), then closes automatically with " +
    "final tallies and percentages and disables its buttons. Wrap the question and " +
    "any multi-word options in quotes.",
  examples: ['poll "best food?" "pizza" "pasta" "curry" 10', 'poll lunch sushi ramen'],
  cooldownSeconds: 5,

  prefixExecute: async (message: Message, args: string[]) => {
    const { question, options, minutes } = parsePollArgs(args);

    // Every other user-text command sanitizes before an embed is
    // built — poll was the lone gap: the question/option text went
    // raw into the embed title/description AND the button labels,
    // letting @everyone render and invisible characters spoof labels.
    const safeQuestion = sanitizeEchoOrReject(question);
    if (!safeQuestion) {
      throw new UserInputError("The question can't be all invisible characters — give it something readable.");
    }
    const safeOptions: string[] = [];
    for (const option of options) {
      const safe = sanitizeEchoOrReject(option);
      if (!safe) {
        throw new UserInputError(`Every option needs some readable text — option ${safeOptions.length + 1} is all invisible characters.`);
      }
      safeOptions.push(safe);
    }

    const durationMs = minutes * 60_000;
    const endUnix = Math.floor((Date.now() + durationMs) / 1000);

    log.info("CMD", `poll by ${message.author.tag} (${message.author.id}): "${safeQuestion}" with ${safeOptions.length} options for ${minutes}m`);

    const votes = new Map<string, number>(); // userId -> option index

    const buttons = safeOptions.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`poll-${i}`)
        .setLabel(opt.slice(0, 80))
        .setEmoji(NUMBER_EMOJI[i])
        .setStyle(ButtonStyle.Primary),
    );
    const rows = chunkRows(buttons);

    const sent = await message.reply({
      embeds: [buildResultsEmbed(safeQuestion, safeOptions, votes, false, endUnix)],
      components: rows,
    });

    // Same serialization chain as v0.5.2's poll: votes apply to the
    // Map synchronously, display updates chain in submission order so
    // the shown counts can never regress.
    let updateChain: Promise<void> = Promise.resolve();

    const collector = sent.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: durationMs,
      // Anyone may vote (polls are public by design) — the filter
      // only stops bot accounts from voting.
      filter: (i) => !i.user.bot,
    });

    collector.on("collect", async (i: ButtonInteraction) => {
      const optionIndex = Number(i.customId.split("-")[1]);
      votes.set(i.user.id, optionIndex);
      log.info("CMD", `Poll vote: ${i.user.tag} (${i.user.id}) voted option ${optionIndex} ("${safeOptions[optionIndex]}") on "${safeQuestion}"`);

      updateChain = updateChain
        .then(async () => {
          await i.update({ embeds: [buildResultsEmbed(safeQuestion, safeOptions, votes, false, endUnix)] });
        })
        .catch((error) => log.error("CMD", "Failed to update poll message after a vote", error));
    });

    collector.on("end", () => {
      log.info("CMD", `Poll "${safeQuestion}" closed with ${votes.size} total vote(s).`);
      const disabledRows = rows.map((row) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          row.components.map((b) => ButtonBuilder.from(b).setDisabled(true)),
        ),
      );
      // message.edit() (bot token) — interaction tokens are irrelevant
      // here and polls can run up to 60 minutes.
      updateChain = updateChain
        .then(async () => {
          await sent.edit({
            embeds: [buildResultsEmbed(safeQuestion, safeOptions, votes, true, endUnix)],
            components: disabledRows,
          });
        })
        .catch((error) => log.error("CMD", "Failed to finalize poll message on close", error));
    });
  },
};

export default command;
