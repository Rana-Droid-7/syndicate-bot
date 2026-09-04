import { jokeRepository, type JokeRow } from "../repositories/jokes.js";
import { log } from "../core/logger.js";
import { sanitizeEcho, truncate } from "../lib/validation.js";

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
    const safe = sanitizeEcho(content.trim());
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
    const safe = sanitizeEcho(content.trim());
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
    return truncate(sanitizeEcho(joke.content), 400);
  },
};
