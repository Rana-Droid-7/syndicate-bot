import { warningRepository, MAX_WARNINGS_PER_USER, type WarningRow } from "../repositories/warnings.js";
import { UserInputError } from "../lib/errors.js";
import { log } from "../core/logger.js";
import { truncate } from "../lib/validation.js";

export interface WarningsListResult {
  description: string;
  totalCount: number;
  shownCount: number;
}

const REASON_DISPLAY_LIMIT = 150;
const DESCRIPTION_LIMIT = 3800;

/**
 * Warning service — all moderation warning business logic. The cap
 * is enforced in the repository transaction; this layer shapes data
 * for display.
 */
export const warningService = {
  add(guildId: string, userId: string, moderatorId: string, reason: string): number {
    // Shape the reason like every other stored field: the slash
    // option's maxLength is UI-enforced only — a crafted direct API
    // call with an empty/oversized reason would hit the DB CHECK and
    // crash to a generic error instead of a clean taxonomy one.
    const shaped = reason.trim().slice(0, 500);
    if (!shaped) {
      throw new UserInputError("Give the warning a reason — it can't be empty.", "/warn add <user> reason: <why>");
    }
    const count = warningRepository.add(guildId, userId, moderatorId, shaped, Date.now());
    log.info("WARN", `Added warning for ${userId} in guild ${guildId} by ${moderatorId}. Total: ${count}.`);
    if (count >= MAX_WARNINGS_PER_USER) {
      log.warn("WARN", `User ${userId} in guild ${guildId} reached the ${MAX_WARNINGS_PER_USER}-warning cap — oldest rolled off.`);
    }
    return count;
  },

  activeFor(guildId: string, userId: string): WarningRow[] {
    return warningRepository.activeFor(guildId, userId);
  },

  clearActive(guildId: string, userId: string): number {
    const count = warningRepository.clearActive(guildId, userId);
    log.info("WARN", `Cleared ${count} warning(s) for ${userId} in guild ${guildId}.`);
    return count;
  },

  /**
   * Formats an active warning list for an embed, newest first.
   *
   * activeFor() returns rows newest-first, so overflow must drop
   * entries from the TAIL (the oldest) — slicing from the front
   * (the previous implementation) showed the oldest warnings and
   * hid exactly the recent ones moderators need for decisions.
   */
  formatList(warnings: WarningRow[]): WarningsListResult {
    const allLines = warnings.map((w, i) => {
      const reason = w.reason.length > REASON_DISPLAY_LIMIT ? `${truncate(w.reason, REASON_DISPLAY_LIMIT)}` : w.reason;
      return `**${i + 1}.** ${reason}\n_by <@${w.moderator_id}> — <t:${Math.floor(w.created_unix_ms / 1000)}:R>_`;
    });

    let hidden = 0;
    while (warnings.length - hidden > 1) {
      const shown = allLines.slice(0, warnings.length - hidden);
      const body = shown.join("\n\n");
      const note = hidden > 0 ? `\n_…${hidden} older warning(s) hidden to fit._` : "";
      if (note.length + body.length <= DESCRIPTION_LIMIT) {
        return {
          description: note + body,
          totalCount: warnings.length,
          shownCount: warnings.length - hidden,
        };
      }
      hidden++;
    }

    // Even one entry can't fit: show only the NEWEST warning (index 0
    // in the newest-first list), never the oldest.
    return {
      description: allLines[0] ?? "",
      totalCount: warnings.length,
      shownCount: warnings.length > 0 ? 1 : 0,
    };
  },
};
