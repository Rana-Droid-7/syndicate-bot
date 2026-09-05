import { jokeRepository, type JokeRow } from "../repositories/jokes.js";
import { log } from "../core/logger.js";
import { sanitizeEcho, sanitizeEchoOrReject, truncate } from "../lib/validation.js";
import { UserInputError } from "../lib/errors.js";

// Matches the DB CHECK constraint on jokes.content. Truncation happens
// AFTER sanitization here because sanitizeEcho EXPANDS text (each
// @everyone/@here gains a zero-width mention-breaker) — validating the
// raw input alone can't stop the stored result from exceeding the
// constraint and crashing the insert.
const MAX_JOKE_LENGTH = 500;

/**
 * Shared sanitize-then-truncate shaping for add/edit. Returns null
 * when the input sanitizes to nothing (invisible characters only) —
 * the caller turns that into a UserInputError before any SQL runs,
 * instead of the insert crashing on the DB CHECK (BETWEEN 1 AND 500).
 */
function shape(content: string): string | null {
  const safe = sanitizeEchoOrReject(content);
  return safe !== null ? truncate(safe, MAX_JOKE_LENGTH) : null;
}

/**
 * Joke service. Public reads are random SQL-side; every mutation is
 * developer-only and validated here before touching the store.
 */
export const jokeService = {
  /** One random enabled joke (usage counter bumped in the same transaction). */
  random(): JokeRow | null {
    return jokeRepository.randomWithUsage();
  },

  countEnabled(): number {
    return jokeRepository.countEnabled();
  },

  add(content: string, developerId: string): number {
    const safe = shape(content);
    if (safe === null) {
      throw new UserInputError("That joke is nothing but invisible characters — give it actual text.");
    }
    const id = jokeRepository.add(safe, developerId);
    log.info("COOLSIES", `Joke #${id} added by developer ${developerId}.`);
    return id;
  },

  list(limit = 25, offset = 0): JokeRow[] {
    return jokeRepository.list(limit, offset);
  },

  countAll(): number {
    return jokeRepository.countAll();
  },

  remove(id: number): boolean {
    const ok = jokeRepository.remove(id);
    log.info("COOLSIES", ok ? `Joke #${id} removed.` : `Joke #${id} remove failed — not found.`);
    return ok;
  },

  edit(id: number, content: string): boolean {
    const safe = shape(content);
    if (safe === null) {
      throw new UserInputError("That joke is nothing but invisible characters — give it actual text.");
    }
    const ok = jokeRepository.edit(id, safe);
    log.info("COOLSIES", ok ? `Joke #${id} edited.` : `Joke #${id} edit failed — not found.`);
    return ok;
  },

  setEnabled(id: number, enabled: boolean): boolean {
    const ok = jokeRepository.setEnabled(id, enabled);
    log.info("COOLSIES", ok ? `Joke #${id} ${enabled ? "enabled" : "disabled"}.` : `Joke #${id} toggle failed — not found.`);
    return ok;
  },

  /** Display-safe joke text for embeds. */
  display(joke: JokeRow): string {
    // Rows can only be stored through the shape() gate, so this can't
    // be empty — sanitize again anyway for defense in depth.
    return truncate(sanitizeEcho(joke.content) || "[empty]", 400);
  },
};
