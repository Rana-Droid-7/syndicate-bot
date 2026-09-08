/**
 * Error-detail shaping for logs.
 *
 * Devlogs and the log mirror carry error text into Discord channels.
 * Raw error dumps leak internals (absolute paths, SQL fragments,
 * tokens from misconfigured fetches). Everything routed to a channel
 * passes through errorDetail() here first.
 */

/** Hard cap — enough for a stack head, never a full dump. */
const MAX_ERROR_CHARS = 1000;

const CENSOR_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // Bot token shapes (header/authorization/query/bare).
  { pattern: /(?:Bot\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, replacement: "[redacted]" },
  // Bearer-style secrets.
  { pattern: /\bBearer\s+[A-Za-z0-9._-]{10,}/gi, replacement: "Bearer [redacted]" },
  // Connection strings with embedded credentials.
  { pattern: /:\/\/[^\s/:@]+:[^\s/@]+@/g, replacement: "://[redacted]@" },
  // Webhook URLs — id/token in the path, no dots for the token shape
  // above to catch. Same shape family as the bot token.
  { pattern: /discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/[\w-]+\/[\w-]+/gi, replacement: "webhook:[redacted]" },
];

/** Truncates and censors error text for safe display in a log channel. */
export function errorDetail(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = `${error.name}: ${error.message}`;
  else text = String(error);

  for (const { pattern, replacement } of CENSOR_PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  // Codeblock fences inside the text can't close the wrapper early.
  text = text.replace(/```/g, "ʼʼʼ");
  return text.slice(0, MAX_ERROR_CHARS);
}

/** Cap for user-facing error text — short reason, never a dump. */
const MAX_USER_ERROR_CHARS = 150;

/**
 * A SHORT, user-facing reason from a caught Discord API error.
 * Shows the API's own message (e.g. "Missing Permissions") without
 * the code path, request body, or anything else internal. Used by
 * moderation/admin failure embeds so users get a real reason while
 * nothing leaks.
 */
export function safeErrorText(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const { pattern, replacement } of CENSOR_PATTERNS) {
    message = message.replace(pattern, replacement);
  }
  return message.slice(0, MAX_USER_ERROR_CHARS) || "unknown error";
}
