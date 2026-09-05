import { eightBallRepository, type EightBallRow } from "../repositories/eightball.js";
import { log } from "../core/logger.js";
import { sanitizeEcho, sanitizeEchoOrReject, truncate } from "../lib/validation.js";
import { UserInputError } from "../lib/errors.js";

// Matches the DB CHECK constraint on eightball.content. Truncation
// happens AFTER sanitization — sanitizeEcho expands @-mentions, so the
// stored value must be shaped here, never trusted from raw input.
const MAX_RESPONSE_LENGTH = 300;

/**
 * Shared sanitize-then-truncate shaping for add/edit. Returns null
 * when the input sanitizes to nothing (invisible characters only) —
 * the caller turns that into a UserInputError before any SQL runs,
 * instead of the insert crashing on the DB CHECK (BETWEEN 1 AND 300).
 */
function shape(content: string): string | null {
  const safe = sanitizeEchoOrReject(content);
  return safe !== null ? truncate(safe, MAX_RESPONSE_LENGTH) : null;
}

/**
 * 8-ball service — mirrors the joke service: public random reads,
 * developer-only mutations, display-safe shaping.
 */
export const eightBallService = {
  /** One random enabled response (usage counter bumped in the same transaction). */
  random(): EightBallRow | null {
    return eightBallRepository.randomWithUsage();
  },

  countEnabled(): number {
    return eightBallRepository.countEnabled();
  },

  countAll(): number {
    return eightBallRepository.countAll();
  },

  add(content: string, developerId: string): number {
    const safe = shape(content);
    if (safe === null) {
      throw new UserInputError("That response is nothing but invisible characters — give it actual text.");
    }
    const id = eightBallRepository.add(safe, developerId);
    log.info("COOLSIES", `8ball response #${id} added by developer ${developerId}.`);
    return id;
  },

  list(limit = 25, offset = 0): EightBallRow[] {
    return eightBallRepository.list(limit, offset);
  },

  remove(id: number): boolean {
    const ok = eightBallRepository.remove(id);
    log.info("COOLSIES", ok ? `8ball response #${id} removed.` : `8ball response #${id} remove failed — not found.`);
    return ok;
  },

  edit(id: number, content: string): boolean {
    const safe = shape(content);
    if (safe === null) {
      throw new UserInputError("That response is nothing but invisible characters — give it actual text.");
    }
    const ok = eightBallRepository.edit(id, safe);
    log.info("COOLSIES", ok ? `8ball response #${id} edited.` : `8ball response #${id} edit failed — not found.`);
    return ok;
  },

  setEnabled(id: number, enabled: boolean): boolean {
    const ok = eightBallRepository.setEnabled(id, enabled);
    log.info(
      "COOLSIES",
      ok ? `8ball response #${id} ${enabled ? "enabled" : "disabled"}.` : `8ball response #${id} toggle failed — not found.`,
    );
    return ok;
  },

  /** Display-safe response text for embeds. */
  display(response: EightBallRow): string {
    // Rows can only be stored through the shape() gate, so this can't
    // be empty — sanitize again anyway for defense in depth.
    return truncate(sanitizeEcho(response.content) || "[empty]", 300);
  },
};
