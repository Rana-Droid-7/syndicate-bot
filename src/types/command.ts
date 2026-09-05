import type {
  ChatInputCommandInteraction,
  ContextMenuCommandBuilder,
  Message,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  UserContextMenuCommandInteraction,
} from "discord.js";

export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/**
 * Where a command is available. v0.5.0's rule: public commands live
 * on the `>` prefix (slash optional where structured input genuinely
 * helps), sensitive commands (moderation/admin/developer) are
 * slash-ONLY — structured input plus Discord's native permission
 * gating.
 */
export type CommandSurface = "prefix-only" | "slash-only" | "both";

export type CommandCategory = "utility" | "coolsies" | "moderation" | "admin" | "owner";

/**
 * A single command definition powering the `>` prefix and (where
 * applicable) the native slash surface. The metadata block is the
 * single source of truth the loader, help system, cooldowns, and
 * suggestion engine all read from.
 */
export interface Command {
  /** Slash builder. Required for every surface EXCEPT "prefix-only". */
  data?: SlashCommandData;
  category: CommandCategory;
  /** One-line description — the menu text. Required for every command. */
  description: string;
  /**
   * Extended help block shown by `>help <command>`. Markdown-safe
   * prose: what it does, how it behaves, tips. Omit for simple
   * commands where the one-liner says it all.
   */
  details?: string;
  /** Human-facing usage line, e.g. ">remindme <time> <text>" or "/kick <user> [reason]". */
  usage: string;
  /** Short examples shown in help detail pages. */
  examples?: string[];
  /** Cooldown in seconds per user per command; 0 (omitted) = none. */
  cooldownSeconds?: number;
  /**
   * Which surfaces this command exists on. The loader validates
   * consistency (a "prefix-only" command with no prefixExecute is a
   * load error, and vice versa).
   */
  surface: CommandSurface;
  /** Canonical name. Defaults to the first prefixName for prefix-only commands. */
  name?: string;

  /** Slash entrypoint. Required unless surface is "prefix-only". */
  execute?: (interaction: ChatInputCommandInteraction) => Promise<void>;
  /** Prefix entrypoint. Required unless surface is "slash-only". */
  prefixExecute?: (message: Message, args: string[]) => Promise<void>;
  /** Prefix aliases, in addition to the canonical name. */
  prefixNames?: string[];
}

/**
 * A right-click user command (Apps menu on a user). Same loader and
 * same collection as slash commands — dispatched from
 * interactionCreate when a UserContextMenuCommandInteraction arrives.
 */
export interface UserContextCommand {
  data: ContextMenuCommandBuilder;
  category: CommandCategory;
  /** One-line description — the menu text. */
  description: string;
  contextMenu: true;
  execute: (interaction: UserContextMenuCommandInteraction) => Promise<void>;
}

export type AnyCommand = Command | UserContextCommand;
