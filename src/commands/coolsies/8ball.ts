import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed, successEmbed } from "../../lib/embeds.js";
import { isDeveloper } from "../../lib/permissions.js";
import { eightBallService } from "../../services/eightball.js";
import { PermissionError, UserInputError } from "../../lib/errors.js";
import { parseIntInRange, safeBoldText, sanitizeEcho, truncate } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

const MAX_RESPONSE_LENGTH = 300;
const LIST_PAGE_SIZE = 10;
const USAGE = '>8ball <question> · >8ball add "<response>" · >8ball list [page] · >8ball remove <id> · >8ball edit <id> "<new>" · >8ball enable/disable <id>';

// ============================================================
// Public: ask
// ============================================================
async function askMessage(message: Message, question: string): Promise<void> {
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

// ============================================================
// Developer-only management, shared by both surfaces
// ============================================================
function requireDeveloper(userId: string): void {
  if (!isDeveloper(userId)) {
    throw new PermissionError("8-ball management is developer-only.");
  }
}

function handleAdd(message: Message, content: string): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!content || content.length > MAX_RESPONSE_LENGTH) {
    throw new UserInputError(
      `The response must be between 1 and ${MAX_RESPONSE_LENGTH} characters — wrap it in quotes.`,
      `>8ball add "<response>"`,
    );
  }
  const id = eightBallService.add(content, message.author.id);
  return message.reply({ embeds: [successEmbed(`Response **#${id}** added — it's now in rotation.`)] });
}

function handleList(message: Message, args: string[]): Promise<unknown> {
  requireDeveloper(message.author.id);
  let page = 1;
  if (args[0]) page = parseIntInRange(args[0], 1, 1000, "page number");
  const total = eightBallService.countAll();
  if (total === 0) {
    return message.reply({
      embeds: [baseEmbed().setTitle("🎱 8-Ball Responses").setDescription("The collection is empty — add some with `>8ball add \"...\"`.")],
    });
  }

  const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page_ = Math.min(page, pages);
  const rows = eightBallService.list(LIST_PAGE_SIZE, (page_ - 1) * LIST_PAGE_SIZE);

  const lines = rows.map((r) => `**#${r.id}** ${r.enabled ? "" : "_(disabled)_ "}${truncate(sanitizeEcho(r.content), 80)}`);
  return message.reply({
    embeds: [
      baseEmbed()
        .setTitle(`🎱 8-Ball Responses — ${total} total`)
        .setDescription(lines.join("\n"))
        .setFooter({ text: `Page ${page_}/${pages} · >8ball remove <id> · >8ball edit <id> "new text"` }),
    ],
  });
}

function handleRemove(message: Message, args: string[]): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!args[0]) throw new UserInputError("Give me the response ID to remove — `>8ball remove 12`.", ">8ball remove <id>");
  const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, "response ID");
  if (!eightBallService.remove(id)) {
    return message.reply({ embeds: [errorEmbed(`There's no response #${id} — check \`>8ball list\`.`)] });
  }
  return message.reply({ embeds: [successEmbed(`Response **#${id}** removed.`)] });
}

function handleEdit(message: Message, args: string[], newContent: string): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!args[0]) {
    throw new UserInputError(
      "Give me the response ID and the new text — `>8ball edit 12 \"new text\"`.",
      `>8ball edit <id> "<new response>"`,
    );
  }
  const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, "response ID");
  if (!newContent || newContent.length > MAX_RESPONSE_LENGTH) {
    throw new UserInputError(`The new response must be between 1 and ${MAX_RESPONSE_LENGTH} characters — wrap it in quotes.`);
  }
  if (!eightBallService.edit(id, newContent)) {
    return message.reply({ embeds: [errorEmbed(`There's no response #${id} — check \`>8ball list\`.`)] });
  }
  return message.reply({ embeds: [successEmbed(`Response **#${id}** updated.`)] });
}

function handleToggle(message: Message, args: string[], enable: boolean): Promise<unknown> {
  requireDeveloper(message.author.id);
  if (!args[0]) {
    throw new UserInputError(
      `Give me the response ID — \`>8ball ${enable ? "enable" : "disable"} 12\`.`,
      `>8ball ${enable ? "enable" : "disable"} <id>`,
    );
  }
  const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, "response ID");
  if (!eightBallService.setEnabled(id, enable)) {
    return message.reply({ embeds: [errorEmbed(`There's no response #${id} — check \`>8ball list\`.`)] });
  }
  return message.reply({
    embeds: [
      successEmbed(`Response **#${id}** ${enable ? "enabled — back in rotation" : "disabled — out of rotation"}.`),
    ],
  });
}

const command: Command = {
  category: "coolsies",
  surface: "both",
  usage: USAGE,
  description: "Ask the magic 8-ball a question — or (developers) manage its response pool.",
  details:
    "Ask anything and the ball answers from its pool of classic responses. " +
    "Everyone can ask; only the bot's configured developers can manage the pool " +
    "(add/list/remove/edit/enable/disable) — the check is against trusted user IDs, never roles. " +
    "Ask on either surface (`>8ball will I win?` or `/8ball`), manage with the same subcommands as `/joke`.",
  examples: [">8ball will I win the lottery?", ">8ball add \"Absolutely, yes.\"", ">8ball list", ">8ball remove 3"],
  cooldownSeconds: 5,
  data: new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Ask the magic 8-ball a question.")
    .addSubcommand((sub) => sub.setName("ask").setDescription("Ask the 8-ball a question.")
      .addStringOption((o) => o.setName("question").setDescription("Your yes/no question").setRequired(true).setMaxLength(200)))
    .addSubcommand((sub) => sub.setName("add").setDescription("Add a response. (Developer only)")
      .addStringOption((o) => o.setName("response").setDescription("The response text").setRequired(true).setMaxLength(MAX_RESPONSE_LENGTH)))
    .addSubcommand((sub) => sub.setName("list").setDescription("Browse the response pool. (Developer only)")
      .addIntegerOption((o) => o.setName("page").setDescription("Page number").setRequired(false).setMinValue(1)))
    .addSubcommand((sub) => sub.setName("remove").setDescription("Remove a response by ID. (Developer only)")
      .addIntegerOption((o) => o.setName("id").setDescription("Response ID").setRequired(true).setMinValue(1)))
    .addSubcommand((sub) => sub.setName("edit").setDescription("Edit a response by ID. (Developer only)")
      .addIntegerOption((o) => o.setName("id").setDescription("Response ID").setRequired(true).setMinValue(1))
      .addStringOption((o) => o.setName("response").setDescription("New response text").setRequired(true).setMaxLength(MAX_RESPONSE_LENGTH)))
    .addSubcommand((sub) => sub.setName("enable").setDescription("Re-enable a response. (Developer only)")
      .addIntegerOption((o) => o.setName("id").setDescription("Response ID").setRequired(true).setMinValue(1)))
    .addSubcommand((sub) => sub.setName("disable").setDescription("Disable a response without deleting it. (Developer only)")
      .addIntegerOption((o) => o.setName("id").setDescription("Response ID").setRequired(true).setMinValue(1))),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    const dev = isDeveloper(interaction.user.id);

    // ask: public. Everything else: developer-only, checked in code.
    if (sub !== "ask" && !dev) {
      await interaction.reply({
        embeds: [errorEmbed("8-ball management is developer-only.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (sub === "ask") {
      const question = interaction.options.getString("question", true).trim();
      if (!question) {
        await interaction.reply({ embeds: [errorEmbed("Ask me an actual question — try `>8ball will I win the lottery?`.")], flags: MessageFlags.Ephemeral });
        return;
      }
      const response = eightBallService.random();
      if (!response) {
        await interaction.reply({ embeds: [errorEmbed("No 8-ball responses are available yet — a developer needs to add some first!")] });
        return;
      }
      await interaction.reply({
        embeds: [
          baseEmbed()
            .setTitle("🎱 The 8-Ball")
            .setDescription(`**${safeBoldText(question)}**\n\n🎱 *${eightBallService.display(response)}*`)
            .setFooter({ text: `Response #${response.id} · ${eightBallService.countEnabled()} in rotation` }),
        ],
      });
      return;
    }

    if (sub === "add") {
      const content = interaction.options.getString("response", true).trim();
      const id = eightBallService.add(content, interaction.user.id);
      await interaction.reply({ embeds: [successEmbed(`Response **#${id}** added — it's now in rotation.`)] });
      return;
    }

    if (sub === "list") {
      const total = eightBallService.countAll();
      if (total === 0) {
        await interaction.reply({ embeds: [baseEmbed().setTitle("🎱 8-Ball Responses").setDescription("The collection is empty — add some with `/8ball add`.")] });
        return;
      }
      const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
      const page = Math.min(interaction.options.getInteger("page") ?? 1, pages);
      const rows = eightBallService.list(LIST_PAGE_SIZE, (page - 1) * LIST_PAGE_SIZE);
      const lines = rows.map((r) => `**#${r.id}** ${r.enabled ? "" : "_(disabled)_ "}${truncate(sanitizeEcho(r.content), 80)}`);
      await interaction.reply({
        embeds: [
          baseEmbed()
            .setTitle(`🎱 8-Ball Responses — ${total} total`)
            .setDescription(lines.join("\n"))
            .setFooter({ text: `Page ${page}/${pages}` }),
        ],
      });
      return;
    }

    // remove / edit / enable / disable all take an ID
    const id = interaction.options.getInteger("id", true);
    if (sub === "remove") {
      if (!eightBallService.remove(id)) {
        await interaction.reply({ embeds: [errorEmbed(`There's no response #${id} — check \`/8ball list\`.`)] });
        return;
      }
      await interaction.reply({ embeds: [successEmbed(`Response **#${id}** removed.`)] });
      return;
    }
    if (sub === "edit") {
      const content = interaction.options.getString("response", true).trim();
      if (!eightBallService.edit(id, content)) {
        await interaction.reply({ embeds: [errorEmbed(`There's no response #${id} — check \`/8ball list\`.`)] });
        return;
      }
      await interaction.reply({ embeds: [successEmbed(`Response **#${id}** updated.`)] });
      return;
    }
    if (sub === "enable" || sub === "disable") {
      const enable = sub === "enable";
      if (!eightBallService.setEnabled(id, enable)) {
        await interaction.reply({ embeds: [errorEmbed(`There's no response #${id} — check \`/8ball list\`.`)] });
        return;
      }
      await interaction.reply({
        embeds: [successEmbed(`Response **#${id}** ${enable ? "enabled — back in rotation" : "disabled — out of rotation"}.`)],
      });
      return;
    }
  },

  prefixNames: ["8ball"],
  prefixExecute: async (message: Message, args: string[]) => {
    // args arrive QUOTE-PARSED from the dispatcher:
    //   >8ball add "absolutely, yes."  ->  ["add", "absolutely, yes."]
    const first = (args[0] ?? "").toLowerCase();
    const MANAGEMENT_SUBS = new Set(["add", "list", "remove", "edit", "enable", "disable"]);

    // If the first word isn't a management subcommand, the WHOLE
    // message is a question — no developer gate applies. This must
    // be decided BEFORE requireDeveloper(), or "will I win?" style
    // questions starting with arbitrary words would be wrongly
    // denied for regular users.
    if (!MANAGEMENT_SUBS.has(first)) {
      const question = args.join(" ").trim();
      if (!question) {
        throw new UserInputError("Ask me a question — try `>8ball will I win the lottery?`.");
      }
      if (question.length > 200) {
        throw new UserInputError("Keep the question under 200 characters.");
      }
      await askMessage(message, question);
      return;
    }

    const restArgs = args.slice(1);

    try {
      // Everything below is developer-only — checked in code against
      // the trusted ID list, never roles.
      requireDeveloper(message.author.id);

      if (first === "add") {
        const content = restArgs.join(" ").trim();
        await handleAdd(message, content);
        return;
      }
      if (first === "list") {
        await handleList(message, restArgs);
        return;
      }
      if (first === "remove") {
        await handleRemove(message, restArgs);
        return;
      }
      if (first === "edit") {
        // >8ball edit 12 "new text" -> args ["edit", "12", "new text"]
        const newContent = restArgs.slice(1).join(" ").trim();
        await handleEdit(message, restArgs, newContent);
        return;
      }
      if (first === "enable") {
        await handleToggle(message, restArgs, true);
        return;
      }
      if (first === "disable") {
        await handleToggle(message, restArgs, false);
        return;
      }
    } catch (error) {
      if (error instanceof PermissionError) {
        log.warn("PERM", `>8ball ${first} DENIED — ${message.author.id} is not a developer.`);
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
