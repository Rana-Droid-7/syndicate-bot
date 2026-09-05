import type {
  ChatInputCommandInteraction,
  Message,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export type SlashCommandData =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

/**
 * Where a command is available. The v0.5.4 policy is strict:
 * public commands (utility, coolsies) are prefix-ONLY; sensitive
 * commands (moderation, admin, developer) are slash-ONLY — Discord's
 * structured input plus native permission gating are part of their
 * safety model. "both" no longer exists in the policy.
 */
export type CommandSurface = "prefix-only" | "slash-only";

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

/** Every loaded command, whatever its surface. */
export type AnyCommand = Command;
