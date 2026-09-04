import { warningRepository, MAX_WARNINGS_PER_USER, type WarningRow } from "../repositories/warnings.js";
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
    const count = warningRepository.add(guildId, userId, moderatorId, reason, Date.now());
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

  /** Formats an active warning list for an embed, newest first. */
  formatList(warnings: WarningRow[]): WarningsListResult {
    const allLines = warnings.map((w, i) => {
      const reason = w.reason.length > REASON_DISPLAY_LIMIT ? `${truncate(w.reason, REASON_DISPLAY_LIMIT)}` : w.reason;
      return `**${i + 1}.** ${reason}\n_by <@${w.moderator_id}> — <t:${Math.floor(w.created_unix_ms / 1000)}:R>_`;
    });

    let hidden = 0;
    while (warnings.length - hidden > 1) {
      const body = allLines.slice(hidden).join("\n\n");
      const note = hidden > 0 ? `_…${hidden} older warning(s) hidden to fit._\n\n` : "";
      if (note.length + body.length <= DESCRIPTION_LIMIT) {
        return {
          description: note + body,
          totalCount: warnings.length,
          shownCount: warnings.length - hidden,
        };
      }
      hidden++;
    }

    return {
      description: allLines[allLines.length - 1] ?? "",
      totalCount: warnings.length,
      shownCount: warnings.length > 0 ? 1 : 0,
    };
  },
};
