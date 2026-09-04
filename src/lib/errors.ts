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
