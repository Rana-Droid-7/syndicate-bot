/**
 * Error taxonomy. Every failure the bot produces is one of these,
 * so command code can throw richly and the dispatcher maps it to a
 * clean, styled user reply + a detailed developer log — no stack
 * traces in public channels, no silent swallowing.
 */

export class BotError extends Error {
  /** Short user-facing message (no internals leaked). */
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Malformed input: bad syntax, invalid duration, unknown target. */
export class UserInputError extends BotError {
  /** Correct usage to show the user. */
  constructor(message: string, public usage?: string) {
    super(message);
  }
}

/** Caller lacks permission / fails the moderation hierarchy. */
export class PermissionError extends BotError {}

/** Wrong place: DMs vs guild, wrong channel type. */
export class ContextError extends BotError {}

/** Database unavailable or a query failed — clean public message, full log. */
export class DatabaseError extends BotError {}

/** Too fast: cooldown hit. */
export class CooldownError extends BotError {
  constructor(message: string, public retryAfterSeconds: number) {
    super(message);
  }
}

/** A user-facing error mapped from the taxonomy above. */
export interface MappedErrorReply {
  /** Embed description text (already styled, no internals). */
  description: string;
  /** Correct usage line, if the error carries one. */
  usage?: string;
  /** True when the error should ALSO reach the dev-log channel. */
  notifyDeveloper: boolean;
}

/** Storage-layer failures get this user text; never the raw SQL. */
export const DB_ERROR_USER_TEXT =
  "Something's wrong with my storage — the developer has been notified. Try again in a moment.";

/**
 * Maps a thrown error to its user-facing reply + devlog policy.
 * Shared by BOTH dispatchers (slash + prefix) so a new error type
 * or message tweak can never drift between them. Returns null for
 * unknown/unexpected errors — the caller logs those with full
 * detail and shows the generic message itself.
 */
export function mapErrorToReply(error: unknown): MappedErrorReply | null {
  if (error instanceof CooldownError) return { description: error.message, notifyDeveloper: false };
  if (error instanceof UserInputError) return { description: error.message, usage: error.usage, notifyDeveloper: false };
  if (error instanceof PermissionError) return { description: error.message, notifyDeveloper: false };
  if (error instanceof ContextError) return { description: error.message, notifyDeveloper: false };
  if (error instanceof DatabaseError) return { description: DB_ERROR_USER_TEXT, notifyDeveloper: true };
  if (error instanceof BotError) return { description: error.message, notifyDeveloper: false };
  return null;
}
