import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { jokeService } from "../../services/jokes.js";
import { UserInputError } from "../../lib/errors.js";
import { buildCollectionHandlers } from "../../lib/collection.js";

const USAGE = 'joke · joke add "<joke>" · joke list [page] · joke remove <id> · joke edit <id> "<new>" · joke enable/disable <id>';

const handlers = buildCollectionHandlers({
  commandName: "joke",
  noun: "joke",
  title: "Jokes",
  emoji: "😂",
  maxLength: 500,
  service: jokeService,
});

// ============================================================
// Public: say
// ============================================================
async function say(message: Message): Promise<void> {
  const joke = jokeService.random();
  if (!joke) {
    await message.reply({
      embeds: [errorEmbed("No jokes are available yet — a developer needs to add some first!")],
    });
    return;
  }
  await message.reply({
    embeds: [
      baseEmbed()
        .setTitle("😂 Joke")
        .setDescription(jokeService.display(joke))
        .setFooter({ text: `Joke #${joke.id} · ${jokeService.countEnabled()} in rotation` }),
    ],
  });
}

const command: Command = {
  category: "coolsies",
  surface: "prefix-only",
  name: "joke",
  usage: USAGE,
  description: "Hear a random joke — or (developers) manage the collection.",
  details:
    "Plain `joke` pulls a random one from the collection — no two visits the same. " +
    "The management subcommands (add/list/remove/edit/enable/disable) are strictly " +
    "for the bot's configured developers, checked against trusted user IDs — never " +
    "server roles, so no admin can grant themselves it. Jokes persist with author, " +
    "timestamps, enable state, and usage counts. Ships with a starter set; grows " +
    "from there.",
  examples: [
    "joke",
    'joke add "Why do programmers prefer dark mode? Because light attracts bugs!"',
    "joke list",
    "joke remove 3",
  ],
  cooldownSeconds: 5,

  prefixExecute: async (message: Message, args: string[]) => {
    // Bare "joke" = hear one. Management verbs follow the shared
    // collection dispatcher; anything else is a clean error with
    // the usage line.
    const sub = (args[0] ?? "").toLowerCase();
    const restArgs = args.slice(1);

    try {
      if (!sub) {
        await say(message);
        return;
      }

      const handled = await handlers.dispatchManagement(message, sub, restArgs);
      if (handled) return;

      throw new UserInputError(
        `I don't know a joke subcommand called \`${sub}\` — plain \`${config.prefix}joke\` tells one.`,
        USAGE,
      );
    } catch (error) {
      const rendered = await handlers.handleManagementError(message, error, sub);
      if (rendered) return;
      throw error;
    }
  },
};

export default command;
