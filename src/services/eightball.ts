import { eightBallRepository, type EightBallRow } from "../repositories/eightball.js";
import { log } from "../core/logger.js";
import { sanitizeEcho, truncate } from "../lib/validation.js";

// Matches the DB CHECK constraint on eightball.content. Truncation
// happens AFTER sanitization — sanitizeEcho expands @-mentions, so the
// stored value must be shaped here, never trusted from raw input.
const MAX_RESPONSE_LENGTH = 300;

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
    const safe = truncate(sanitizeEcho(content.trim()), MAX_RESPONSE_LENGTH);
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
    const safe = truncate(sanitizeEcho(content.trim()), MAX_RESPONSE_LENGTH);
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
    return truncate(sanitizeEcho(response.content), 300);
  },
};
