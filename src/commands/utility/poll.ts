import { type Message, PollLayoutType } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed } from "../../lib/embeds.js";
import { UserInputError, ContextError } from "../../lib/errors.js";
import { escapeInlineCode, sanitizeEchoOrReject } from "../../lib/validation.js";
import { pollService } from "../../services/polls.js";
import { discordTimestamp } from "../../lib/format.js";
import { log } from "../../core/logger.js";

// Native Discord poll limits (developers/docs/resources/poll):
//   question text: 300 chars, answer text: 55 chars, up to 10 answers.
// The duration input is DECIMAL HOURS (0.5 = 30 minutes, 0.01 = 36
// seconds) — Discord only schedules expiry in whole hours, so the
// poll is created with the ceiling and ended EARLY through Discord's
// official End Poll endpoint when the user's exact duration elapses.
const MIN_POLL_HOURS = 0.01; // 36 seconds — anything shorter is spam-bait
const MAX_POLL_HOURS = 168; // 7 days — one week is plenty for a chat poll
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 55;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

/**
 * Splits the post-question argument tokens into options on commas.
 *
 * The dispatcher's quote-aware tokenizer runs FIRST, so a quoted
 * multi-word option arrives as ONE token — `"yes, definitely",` as
 * `yes, definitely,` (trailing comma outside the quotes). Splitting
 * the joined string on every comma would tear quoted options apart;
 * instead a comma terminates an option only when it trails a token
 * (the `", "` separator shape), and commas inside a token stay
 * literal (quote an option that itself contains commas... in which
 * case its INTERNAL commas are exactly the ones that must survive).
 *
 *   "pizza", "pasta", "curry"   -> pizza / pasta / curry
 *   pizza, pasta, curry         -> pizza / pasta / curry
 *   "yes, definitely", no       -> yes, definitely / no
 *   ice cream, cake              -> ice cream / cake  (multi-word, unquoted)
 */
function splitOptions(tokens: string[]): string[] {
  const options: string[] = [];
  let current = "";
  const flush = () => {
    const t = current.trim();
    if (t) options.push(t);
    current = "";
  };
  for (const token of tokens) {
    let tok = token;
    let terminators = 0;
    while (tok.endsWith(",")) {
      tok = tok.slice(0, -1);
      terminators++;
    }
    if (tok) current = current ? `${current} ${tok}` : tok;
    // A trailing comma ends this option — even if the accumulated
    // text is empty (`,,`) it just produces nothing: `a,, b` is `a`
    // then `b`, never a crash on an empty option.
    if (terminators > 0) flush();
  }
  flush(); // the final option has no trailing comma
  return options;
}

/**
 * Parses poll arguments in the v1.1.0 grammar:
 *   poll <hours> "<question>" "<option 1>", "<option 2>" [, ...]
 *
 *   - hours: ALWAYS hours, as a plain decimal (1, 0.5, 0.01)
 *   - question: quoted (multi-word) — first arg after the duration
 *   - options: comma-separated, each optionally quoted (quoting is
 *     required only for options that contain commas)
 *
 * Length validation runs AFTER sanitization, not before: breaking a
 * mass-mention inserts a zero-width space (text EXPANDS), so a raw
 * length check could pass 55 chars and still overflow the native
 * poll's hard answer limit at the API. The order is the same
 * sanitize-then-measure discipline every stored field follows.
 */
export function parsePollArgs(args: string[]): { question: string; options: string[]; hours: number } {
  const USAGE = 'poll <hours> "<question>" "<option 1>", "<option 2>" [, ...]';

  if (args.length < 3) {
    throw new UserInputError(
      `Give me a duration in hours, a quoted question, and at least two comma-separated options — \`${config.prefix}poll 2 "best food?" "pizza", "pasta"\`.`,
      USAGE,
    );
  }

  // --- duration: first arg, decimal hours, strictly plain digits ---
  const timeToken = args[0];
  if (!/^\d+(\.\d+)?$/.test(timeToken)) {
    throw new UserInputError(
      `\`${escapeInlineCode(timeToken)}\` isn't a valid duration — give me hours as a plain decimal number (\`1\`, \`0.5\` for 30 minutes, \`0.01\` for 36 seconds).`,
      USAGE,
    );
  }
  const hours = Number(timeToken);
  if (!Number.isFinite(hours) || hours < MIN_POLL_HOURS || hours > MAX_POLL_HOURS) {
    throw new UserInputError(
      `Duration must be between ${MIN_POLL_HOURS} and ${MAX_POLL_HOURS} hours — decimals are how you go shorter (\`0.5\` = 30 minutes, \`0.01\` = 36 seconds).`,
      USAGE,
    );
  }

  // --- question: second arg (already quote-parsed by the dispatcher) ---
  const question = sanitizeEchoOrReject(args[1].trim());
  if (args[1].trim() && !question) {
    throw new UserInputError("The question can't be all invisible characters — give it something readable.");
  }
  if (!question) {
    throw new UserInputError("Give me a question in quotes — ask something.");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new UserInputError(`Keep the question under ${MAX_QUESTION_LENGTH} characters.`);
  }

  // --- options: everything after the question, comma-separated ---
  const rawOptions = splitOptions(args.slice(2));
  if (rawOptions.length < MIN_OPTIONS) {
    throw new UserInputError(`Give me at least ${MIN_OPTIONS} options, separated by commas.`, USAGE);
  }
  if (rawOptions.length > MAX_OPTIONS) {
    throw new UserInputError(`Max ${MAX_OPTIONS} options (got ${rawOptions.length}).`);
  }

  const options: string[] = [];
  for (const raw of rawOptions) {
    const safe = sanitizeEchoOrReject(raw);
    if (!safe) {
      throw new UserInputError(`Every option needs some readable text — option ${options.length + 1} is all invisible characters.`);
    }
    if (safe.length > MAX_OPTION_LENGTH) {
      throw new UserInputError(`Options must be under ${MAX_OPTION_LENGTH} characters each.`);
    }
    options.push(safe);
  }

  return { question, options, hours };
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "poll",
  usage: 'poll <hours> "<question>" "<option 1>", "<option 2>" [, ...]',
  description: "Create a native Discord poll — decimal-hour duration, comma options, automatic results recap.",
  details:
    "Creates a real native Discord poll (the same kind Discord's own UI " +
    "makes): native one-click voting and live tallies rendered by Discord " +
    "itself. The duration is ALWAYS in hours — decimals welcome: `1` = one " +
    "hour, `0.5` = 30 minutes, `0.01` = 36 seconds (the floor). Give the " +
    "question in quotes, then 2–10 options separated by commas; quote an " +
    "option that itself contains commas. When the set duration ends, the " +
    "bot ends the poll through Discord's official end-poll feature and " +
    "replies with the final tally — winner, vote counts, percentages, ties. " +
    "The recap is persistent: it survives restarts and crashes, like " +
    "reminders. Cap: 10 open polls per person per server.",
  examples: ['poll 2 "best food?" "pizza", "pasta", "curry"', 'poll 0.01 "quick — flip a coin?" "heads", "tails"'],
  cooldownSeconds: 5,

  prefixExecute: async (message: Message, args: string[]) => {
    if (!message.guild) throw new ContextError("Polls only work in a server.");
    if (!message.channel.isTextBased() || !("send" in message.channel)) {
      throw new ContextError("I can't post polls in this type of channel.");
    }

    const { question, options, hours } = parsePollArgs(args);
    const closeUnixMs = Date.now() + Math.round(hours * 3_600_000);
    const closeUnix = Math.floor(closeUnixMs / 1000);

    // Cap BEFORE posting: a cap error discovered after the reply
    // would leave an orphaned poll with no recap promise in the
    // channel. The pre-check throws the same clean taxonomy error
    // create() enforces transactionally.
    pollService.assertCanCreate(message.guild.id, message.author.id);

    // The dispatcher already logged the PREFIX dispatch line with
    // user/guild/args — this adds only the poll-specific substance.
    log.info("PREFIX", `poll: "${question}" with ${options.length} options for ${hours}h`);

    // One message: the poll, plus a bot-authored content line above it
    // telling everyone when it REALLY closes. The content line matters
    // for fractional durations — Discord's own UI shows its whole-hour
    // ceiling (a 0.01h poll would display "1 hour" on its own), while
    // our timer ends it at the exact requested moment.
    const sent = await message.reply({
      content: `📊 Closes ${discordTimestamp(closeUnix, "R")} — final results posted here when it ends.`,
      poll: {
        question: { text: question },
        answers: options.map((text) => ({ text })),
        duration: Math.max(1, Math.ceil(hours)), // whole hours is all the create API accepts
        allowMultiselect: false,
        layoutType: PollLayoutType.Default,
      },
    });

    // The recap promise: a DB row (restart-survivable, same contract
    // as reminders) — when the duration elapses, the poll is ended via
    // the official End Poll endpoint and the final tally posted as a
    // reply. Without the row, a restart would orphan every open poll.
    await pollService.create(
      message.client,
      message.guild.id,
      message.channelId,
      sent.id,
      message.author.id,
      question,
      options,
      closeUnixMs,
    );
  },
};

export default command;
