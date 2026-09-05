import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { eightBallService } from "../../services/eightball.js";
import { UserInputError } from "../../lib/errors.js";
import { safeBoldText } from "../../lib/validation.js";
import { buildCollectionHandlers } from "../../lib/collection.js";
import { log } from "../../core/logger.js";

const MAX_QUESTION_LENGTH = 200;
const USAGE = '8ball <question> · 8ball add "<response>" · 8ball list [page] · 8ball remove <id> · 8ball edit <id> "<new>" · 8ball enable/disable <id>';
const MANAGEMENT_SUBS = new Set(["add", "list", "remove", "edit", "enable", "disable"]);

const handlers = buildCollectionHandlers({
  commandName: "8ball",
  noun: "response",
  title: "8-Ball Responses",
  emoji: "🎱",
  maxLength: 300,
  service: eightBallService,
});

// ============================================================
// Public: ask
// ============================================================
async function ask(message: Message, question: string): Promise<void> {
  const response = eightBallService.random();
  if (!response) {
    await message.reply({
      embeds: [errorEmbed("No 8-ball responses are available yet — a developer needs to add some first!")],
    });
    return;
  }
  log.debug("COOLSIES", `8ball: "${question}" -> response #${response.id}`);
  await message.reply({
    embeds: [
      baseEmbed()
        .setTitle("🎱 The 8-Ball")
        .setDescription(`**${safeBoldText(question)}**\n\n🎱 *${eightBallService.display(response)}*`)
        .setFooter({ text: `Response #${response.id} · ${eightBallService.countEnabled()} in rotation` }),
    ],
  });
}

const command: Command = {
  category: "coolsies",
  surface: "prefix-only",
  name: "8ball",
  usage: USAGE,
  description: "Ask the magic 8-ball a question — or (developers) manage its response pool.",
  details:
    "Ask anything and the ball answers from its pool of classic responses. " +
    "Everyone can ask; only the bot's configured developers can manage the pool " +
    "(add/list/remove/edit/enable/disable) — the check is against trusted user " +
    "IDs, never roles. Ships with 19 classic responses; grows from there.",
  examples: [
    "8ball will I win the lottery?",
    '8ball add "Absolutely, yes."',
    "8ball list",
    "8ball remove 3",
  ],
  cooldownSeconds: 5,

  prefixExecute: async (message: Message, args: string[]) => {
    // args arrive QUOTE-PARSED from the dispatcher:
    //   8ball add "absolutely, yes."  ->  ["add", "absolutely, yes."]
    const first = (args[0] ?? "").toLowerCase();

    // If the first word isn't a management subcommand, the WHOLE
    // message is a question — no developer gate applies. This must
    // be decided BEFORE the management dispatch, or "will I win?"
    // style questions starting with arbitrary words would be
    // wrongly denied for regular users.
    if (!MANAGEMENT_SUBS.has(first)) {
      const question = args.join(" ").trim();
      if (!question) {
        throw new UserInputError("Ask me a question — try `8ball will I win the lottery?`.");
      }
      if (question.length > MAX_QUESTION_LENGTH) {
        throw new UserInputError(`Keep the question under ${MAX_QUESTION_LENGTH} characters.`);
      }
      await ask(message, question);
      return;
    }

    const restArgs = args.slice(1);
    try {
      // Management subcommands are developer-only (gated inside the
      // shared handlers, checked against trusted IDs — never roles).
      const handled = await handlers.dispatchManagement(message, first, restArgs);
      if (!handled) {
        // Unreachable (MANAGEMENT_SUBS pre-filtered), kept for safety.
        throw new UserInputError(`I don't know an 8-ball subcommand called \`${first}\`.`, USAGE);
      }
    } catch (error) {
      const rendered = await handlers.handleManagementError(message, error, first);
      if (rendered) return;
      throw error;
    }
  },
};

export default command;
