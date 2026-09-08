import type { Message } from "discord.js";
import { baseEmbed, errorEmbed, successEmbed } from "./embeds.js";
import { isDeveloper } from "./permissions.js";
import { PermissionError, UserInputError } from "./errors.js";
import { parseIntInRange, sanitizeEcho, truncate } from "./validation.js";
import { log } from "../core/logger.js";

const LIST_PAGE_SIZE = 10;

export interface CollectionRow {
  id: number;
  content: string;
  enabled: number;
}

export interface CollectionService<R extends CollectionRow> {
  /** Insert; returns the new row's ID. */
  add(content: string, authorId: string): number;
  /** All rows (for counts). */
  countAll(): number;
  list(limit: number, offset: number): R[];
  remove(id: number): boolean;
  edit(id: number, content: string): boolean;
  setEnabled(id: number, enabled: boolean): boolean;
}

export interface CollectionConfig<R extends CollectionRow> {
  /** The command's canonical name — for logs and error text. */
  commandName: string;
  /** Singular noun shown in messages — "joke" / "response". */
  noun: string;
  /** Capitalized label for embeds — "Jokes" / "8-Ball Responses". */
  title: string;
  /** Emoji for embeds. */
  emoji: string;
  /** Max stored content length (must match the DB CHECK). */
  maxLength: number;
  /** The service owning this collection. */
  service: CollectionService<R>;
}

/**
 * Shared, developer-gated management handlers for ID-keyed content
 * collections (jokes, 8-ball responses, ...). Every command that
 * plugs in gets the identical add/list/remove/edit/enable/disable
 * family with identical validation, sanitization, and error text —
 * one implementation instead of one copy per command.
 *
 * Sanitization order is fixed here: sanitize FIRST (expands
 * @-mentions with zero-width breakers), truncate AFTER — the
 * ordering that keeps the stored value inside the DB CHECK no
 * matter how hostile the input.
 */
export function buildCollectionHandlers<R extends CollectionRow>(cfg: CollectionConfig<R>) {
  const label = `${cfg.emoji} ${cfg.title}`;

  function requireDeveloper(userId: string): void {
    if (!isDeveloper(userId)) {
      // Audit trail for gate attempts — the RENDERING happens in the
      // shared dispatcher error path now, but the log belongs here
      // where the context is.
      log.warn("PERM", `${cfg.commandName} management DENIED — ${userId} is not a developer.`);
      throw new PermissionError(`${cfg.title} management is developer-only.`);
    }
  }

  async function add(message: Message, content: string): Promise<void> {
    requireDeveloper(message.author.id);
    if (!content || content.length > cfg.maxLength) {
      throw new UserInputError(
        `The ${cfg.noun} must be between 1 and ${cfg.maxLength} characters — wrap it in quotes.`,
        `${cfg.commandName} add "<${cfg.noun}>"`,
      );
    }
    // The service applies sanitize-then-truncate; this check is the
    // friendly pre-flight for obviously oversized input.
    const id = cfg.service.add(content, message.author.id);
    await message.reply({ embeds: [successEmbed(`${cfg.noun[0].toUpperCase()}${cfg.noun.slice(1)} **#${id}** added — it's now in rotation.`)] });
  }

  async function list(message: Message, args: string[]): Promise<void> {
    requireDeveloper(message.author.id);
    let page = 1;
    if (args[0]) page = parseIntInRange(args[0], 1, 1000, "page number");
    const total = cfg.service.countAll();
    if (total === 0) {
      await message.reply({
        embeds: [baseEmbed().setTitle(label).setDescription(`The collection is empty — add some with \`${cfg.commandName} add "..."\`.`)],
      });
      return;
    }

    const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    const page_ = Math.min(page, pages);
    const rows = cfg.service.list(LIST_PAGE_SIZE, (page_ - 1) * LIST_PAGE_SIZE);

    const lines = rows.map((r) => `**#${r.id}** ${r.enabled ? "" : "_(disabled)_ "}${truncate(sanitizeEcho(r.content), 80)}`);
    await message.reply({
      embeds: [
        baseEmbed()
          .setTitle(`${label} — ${total} total`)
          .setDescription(lines.join("\n"))
          .setFooter({ text: `Page ${page_}/${pages} · ${cfg.commandName} remove <id> · ${cfg.commandName} edit <id> "new text"` }),
      ],
    });
  }

  async function remove(message: Message, args: string[]): Promise<void> {
    requireDeveloper(message.author.id);
    if (!args[0]) {
      throw new UserInputError(`Give me the ${cfg.noun} ID to remove — \`${cfg.commandName} remove 12\`.`, `${cfg.commandName} remove <id>`);
    }
    const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, `${cfg.noun} ID`);
    if (!cfg.service.remove(id)) {
      await message.reply({ embeds: [errorEmbed(`There's no ${cfg.noun} #${id} — check \`${cfg.commandName} list\`.`)] });
      return;
    }
    await message.reply({ embeds: [successEmbed(`${cfg.noun[0].toUpperCase()}${cfg.noun.slice(1)} **#${id}** removed.`)] });
  }

  async function edit(message: Message, args: string[], newContent: string): Promise<void> {
    requireDeveloper(message.author.id);
    if (!args[0]) {
      throw new UserInputError(
        `Give me the ${cfg.noun} ID and the new text — \`${cfg.commandName} edit 12 "new text"\`.`,
        `${cfg.commandName} edit <id> "<new ${cfg.noun}>"`,
      );
    }
    const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, `${cfg.noun} ID`);
    if (!newContent || newContent.length > cfg.maxLength) {
      throw new UserInputError(`The new ${cfg.noun} must be between 1 and ${cfg.maxLength} characters — wrap it in quotes.`);
    }
    if (!cfg.service.edit(id, newContent)) {
      await message.reply({ embeds: [errorEmbed(`There's no ${cfg.noun} #${id} — check \`${cfg.commandName} list\`.`)] });
      return;
    }
    await message.reply({ embeds: [successEmbed(`${cfg.noun[0].toUpperCase()}${cfg.noun.slice(1)} **#${id}** updated.`)] });
  }

  async function toggle(message: Message, args: string[], enable: boolean): Promise<void> {
    requireDeveloper(message.author.id);
    if (!args[0]) {
      throw new UserInputError(
        `Give me the ${cfg.noun} ID — \`${cfg.commandName} ${enable ? "enable" : "disable"} 12\`.`,
        `${cfg.commandName} ${enable ? "enable" : "disable"} <id>`,
      );
    }
    const id = parseIntInRange(args[0], 1, Number.MAX_SAFE_INTEGER, `${cfg.noun} ID`);
    if (!cfg.service.setEnabled(id, enable)) {
      await message.reply({ embeds: [errorEmbed(`There's no ${cfg.noun} #${id} — check \`${cfg.commandName} list\`.`)] });
      return;
    }
    await message.reply({
      embeds: [successEmbed(`${cfg.noun[0].toUpperCase()}${cfg.noun.slice(1)} **#${id}** ${enable ? "enabled — back in rotation" : "disabled — out of rotation"}.`)],
    });
  }

  /**
   * Dispatch a management subcommand. Returns true if `sub` was a
   * management verb and was handled (even if it errored cleanly);
   * false if the caller should treat the input as something else.
   * PermissionError and UserInputError propagate to the caller's
   * catch — identical rendering everywhere.
   */
  async function dispatchManagement(
    message: Message,
    sub: string,
    restArgs: string[],
  ): Promise<boolean> {
    switch (sub) {
      case "add":
        await add(message, restArgs.join(" ").trim());
        return true;
      case "list":
        await list(message, restArgs);
        return true;
      case "remove":
        await remove(message, restArgs);
        return true;
      case "edit":
        await edit(message, restArgs, restArgs.slice(1).join(" ").trim());
        return true;
      case "enable":
        await toggle(message, restArgs, true);
        return true;
      case "disable":
        await toggle(message, restArgs, false);
        return true;
      default:
        return false;
    }
  }

  return { requireDeveloper, add, list, remove, edit, toggle, dispatchManagement };
}
