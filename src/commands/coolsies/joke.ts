import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed, successEmbed } from "../../lib/embeds.js";
import { isDeveloper } from "../../lib/permissions.js";
import { jokeService } from "../../services/jokes.js";
import { UserInputError, PermissionError } from "../../lib/errors.js";
import { parseIntInRange, sanitizeEcho, truncate } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

const MAX_JOKE_LENGTH = 500;
const LIST_PAGE_SIZE = 10;
const USAGE = ">joke say · >joke add \"<joke>\" · >joke list [page] · >joke remove <id> · >joke edit <id> \"<new>\" · >joke enable/disable <id>";

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

// ============================================================
// Developer-only management, shared by both surfaces
// ============================================================
function requireDeveloper(userId: string): void {
  if (!isDeveloper(userId)) {
    throw new PermissionError("Joke management is developer-only.");
  }
}

function handleAdd(message: Message, content: string): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!content || content.length > MAX_JOKE_LENGTH) {
    throw new UserInputError(`The joke must be between 1 and ${MAX_JOKE_LENGTH} characters — wrap it in quotes.`, `>joke add "<joke>"`);
  }
  const id = jokeService.add(content, message.author.id);
  return message.reply({ embeds: [successEmbed(`Joke **#${id}** added — it's now in rotation.`)] });
}

function handleList(message: Message, args: string[]): Promise<unknown> {
  requireDeveloper(message.author.id);
  let page = 1;
  if (args[0]) page = parseIntInRange(args[0], 1, 1000, "page number");
  const total = jokeService.countAll();
  if (total === 0) {
    return message.reply({ embeds: [baseEmbed().setTitle("😂 Jokes").setDescription("The collection is empty — add some with `>joke add \"...\"`.")] });
  }

  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page_ = Math.min(page, pages);
  const rows = jokeService.list(LIST_PAGE_SIZE, (page_ - 1) * LIST_PAGE_SIZE);

  const lines = rows.map((j) => `**#${j.id}** ${j.enabled ? "" : "_(disabled)_ "}${truncate(sanitizeEcho(j.content), 80)}`);
  return message.reply({
    embeds: [
      baseEmbed()
        .setTitle(`😂 Jokes — ${total} total`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Page ${page_}/${pages} · >joke remove <id> · >joke edit <id> "new text"` }),
    ],
  });
}

function handleRemove(message: Message, args: string[]): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!args[0]) throw new UserInputError("Give me the joke ID to remove — `>joke remove 12`.", ">joke remove <id>");
  const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, "joke ID");
  if (!jokeService.remove(id)) {
    return message.reply({ embeds: [errorEmbed(`There's no joke #${id} — check \`>joke list\`.`)] });
  }
  return message.reply({ embeds: [successEmbed(`Joke **#${id}** removed.`)] });
}

function handleEdit(message: Message, args: string[], newContent: string): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!args[0]) throw new UserInputError("Give me the joke ID and the new text — `>joke edit 12 \"new text\"`.", `>joke edit <id> "<new joke>"`);
  const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, "joke ID");
  if (!newContent || newContent.length > MAX_JOKE_LENGTH) {
    throw new UserInputError(`The new joke must be between 1 and ${MAX_JOKE_LENGTH} characters — wrap it in quotes.`);
  }
  if (!jokeService.edit(id, newContent)) {
    return message.reply({ embeds: [errorEmbed(`There's no joke #${id} — check \`>joke list\`.`)] });
  }
  return message.reply({ embeds: [successEmbed(`Joke **#${id}** updated.`)] });
}

function handleToggle(message: Message, args: string[], enable: boolean): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!args[0]) {
    throw new UserInputError(
      `Give me the joke ID — \`>joke ${enable ? "enable" : "disable"} 12\`.`,
      `>joke ${enable ? "enable" : "disable"} <id>`,
    );
  }
  const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, "joke ID");
  if (!jokeService.setEnabled(id, enable)) {
    return message.reply({ embeds: [errorEmbed(`There's no joke #${id} — check \`>joke list\`.`)] });
  }
  return message.reply({ embeds: [successEmbed(`Joke **#${id}** ${enable ? "enabled" : "disabled"} ${enable ? "— back in rotation" : "— out of rotation"}.`)] });
}

const command: Command = {
  category: "coolsies",
  surface: "both",
  usage: USAGE,
  examples: ['>joke say', '>joke add "Why do programmers prefer dark mode? Because light attracts bugs!"', ">joke list", ">joke remove 3"],
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("joke")
    .setDescription("Jokes — say one, or (developers) manage the collection.")
    .addSubcommand((sub) => sub.setName("say").setDescription("Hear a random joke."))
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a joke to the collection. (Developer only)")
        .addStringOption((o) => o.setName("joke").setDescription("The joke text").setRequired(true).setMaxLength(MAX_JOKE_LENGTH)),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("Browse the joke collection. (Developer only)").addIntegerOption((o) =>
        o.setName("page").setDescription("Page number").setRequired(false).setMinValue(1),
      ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a joke by ID. (Developer only)")
        .addIntegerOption((o) => o.setName("id").setDescription("Joke ID").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("edit")
        .setDescription("Edit a joke by ID. (Developer only)")
        .addIntegerOption((o) => o.setName("id").setDescription("Joke ID").setRequired(true).setMinValue(1))
        .addStringOption((o) => o.setName("joke").setDescription("New joke text").setRequired(true).setMaxLength(MAX_JOKE_LENGTH)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Re-enable a disabled joke. (Developer only)")
        .addIntegerOption((o) => o.setName("id").setDescription("Joke ID").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable a joke without deleting it. (Developer only)")
        .addIntegerOption((o) => o.setName("id").setDescription("Joke ID").setRequired(true).setMinValue(1)),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    const dev = isDeveloper(interaction.user.id);

    // say: public. Everything else: developer-only, checked in code.
    if (sub !== "say" && !dev) {
      await interaction.reply({
        embeds: [errorEmbed("Joke management is developer-only.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "say") {
      const joke = jokeService.random();
      if (!joke) {
        await interaction.reply({ embeds: [errorEmbed("No jokes are available yet — a developer needs to add some first!")] });
        return;
      }
      await interaction.reply({
        embeds: [
          baseEmbed()
            .setTitle("😂 Joke")
            .setDescription(jokeService.display(joke))
            .setFooter({ text: `Joke #${joke.id} · ${jokeService.countEnabled()} in rotation` }),
        ],
      });
      return;
    }

    if (sub === "add") {
      const content = interaction.options.getString("joke", true).trim();
      const id = jokeService.add(content, interaction.user.id);
      await interaction.reply({ embeds: [successEmbed(`Joke **#${id}** added — it's now in rotation.`)] });
      return;
    }

    if (sub === "list") {
      const total = jokeService.countAll();
      if (total === 0) {
        await interaction.reply({ embeds: [baseEmbed().setTitle("😂 Jokes").setDescription("The collection is empty — add some with `/joke add`.")] });
        return;
      }
      const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
      const page = Math.min(interaction.options.getInteger("page") ?? 1, pages);
      const rows = jokeService.list(LIST_PAGE_SIZE, (page - 1) * LIST_PAGE_SIZE);
      const lines = rows.map((j) => `**#${j.id}** ${j.enabled ? "" : "_(disabled)_ "}${truncate(sanitizeEcho(j.content), 80)}`);
      await interaction.reply({
        embeds: [
          baseEmbed()
            .setTitle(`😂 Jokes — ${total} total`)
            .setDescription(lines.join("\n"))
            .setFooter({ text: `Page ${page}/${pages}` }),
        ],
      });
      return;
    }

    // remove / edit / enable / disable all take an ID
    const id = interaction.options.getInteger("id", true);
    if (sub === "remove") {
      if (!jokeService.remove(id)) {
        await interaction.reply({ embeds: [errorEmbed(`There's no joke #${id} — check \`/joke list\`.`)] });
        return;
      }
      await interaction.reply({ embeds: [successEmbed(`Joke **#${id}** removed.`)] });
      return;
    }
    if (sub === "edit") {
      const content = interaction.options.getString("joke", true).trim();
      if (!jokeService.edit(id, content)) {
        await interaction.reply({ embeds: [errorEmbed(`There's no joke #${id} — check \`/joke list\`.`)] });
        return;
      }
      await interaction.reply({ embeds: [successEmbed(`Joke **#${id}** updated.`)] });
      return;
    }
    if (sub === "enable" || sub === "disable") {
      const enable = sub === "enable";
      if (!jokeService.setEnabled(id, enable)) {
        await interaction.reply({ embeds: [errorEmbed(`There's no joke #${id} — check \`/joke list\`.`)] });
        return;
      }
      await interaction.reply({
        embeds: [successEmbed(`Joke **#${id}** ${enable ? "enabled — back in rotation" : "disabled — out of rotation"}.`)],
      });
      return;
    }
  },

  prefixNames: ["joke", "j"],
  prefixExecute: async (message: Message, args: string[]) => {
    // args arrive QUOTE-PARSED from the dispatcher:
    //   >joke add "why do coders like dark mode?"
    //     -> ["add", "why do coders like dark mode?"]
    const sub = (args[0] ?? "say").toLowerCase();
    const restArgs = args.slice(1);

    try {
      if (sub === "say") {
        await say(message);
        return;
      }

      // Everything below is developer-only — checked in code against
      // the trusted ID list, never roles.
      requireDeveloper(message.author.id);

      if (sub === "add") {
        const content = restArgs.join(" ").trim();
        await handleAdd(message, content);
        return;
      }
      if (sub === "list") {
        await handleList(message, restArgs);
        return;
      }
      if (sub === "remove") {
        await handleRemove(message, restArgs);
        return;
      }
      if (sub === "edit") {
        // >joke edit 12 "new text" -> args ["edit", "12", "new text"]
        const newContent = restArgs.slice(1).join(" ").trim();
        await handleEdit(message, restArgs, newContent);
        return;
      }
      if (sub === "enable") {
        await handleToggle(message, restArgs, true);
        return;
      }
      if (sub === "disable") {
        await handleToggle(message, restArgs, false);
        return;
      }

      throw new UserInputError(`I don't know a joke subcommand called \`${sub}\`.`, USAGE);
    } catch (error) {
      if (error instanceof PermissionError) {
        log.warn("PERM", `>joke ${sub} DENIED — ${message.author.id} is not a developer.`);
        await message.reply({ embeds: [errorEmbed(error.message)] });
        return;
      }
      if (error instanceof UserInputError) {
        const embed = errorEmbed(error.message);
        if (error.usage) {
          embed.addFields({ name: "Correct usage", value: `\`${error.usage}\``, inline: false });
        }
        await message.reply({ embeds: [embed] });
        return;
      }
      throw error;
    }
  },
};

export default command;
