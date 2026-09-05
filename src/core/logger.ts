import { enqueueMirror } from "./logSink.js";

/**
 * Centralized logger. Every log line gets a timestamp and a tag so
 * it's obvious which subsystem produced it — with logging spread
 * across 40+ files, consistency here is what makes "verbose" mean
 * "readable" instead of "noisy."
 *
 * Two destinations:
 *  1. Console — always, every level (source of truth).
 *  2. Private bot-logs channel — a mirrored, filtered feed (INFO+,
 *     non-DEBUG tags) if BOT_LOG_CHANNEL_ID is wired. See
 *     core/logSink.ts for batching/rate-limit details.
 *
 * Tags in use: BOOT, CMD, PREFIX, EVENT, PERM, MOD, ADMIN, OWNER,
 * CONFIRM, COOLSIES, TIMER, AFK, WARN, SUGGEST, DEVLOG, SHUTDOWN,
 * CALC, HELP, DEPLOY, BANNER.
 */

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: string, tag: string, message: string): string {
  return `[${timestamp()}] [${level}] [${tag}] ${message}`;
}

export const log = {
  info(tag: string, message: string, data?: unknown): void {
    if (data === undefined) console.log(format("INFO", tag, message));
    else console.log(format("INFO", tag, message), data);
    enqueueMirror(tag, "INFO", message);
  },
  debug(tag: string, message: string, data?: unknown): void {
    if (data === undefined) console.log(format("DEBUG", tag, message));
    else console.log(format("DEBUG", tag, message), data);
    // DEBUG is console-only by design — it's the firehose.
  },
  warn(tag: string, message: string, data?: unknown): void {
    if (data === undefined) console.warn(format("WARN", tag, message));
    else console.warn(format("WARN", tag, message), data);
    enqueueMirror(tag, "WARN", message);
  },
  error(tag: string, message: string, error?: unknown): void {
    if (error === undefined) console.error(format("ERROR", tag, message));
    else console.error(format("ERROR", tag, message), error);
    // ERROR is not mirrored: real errors get proper individual
    // dev-log embeds at the call sites that know the context.
  },
};
