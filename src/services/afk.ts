import { afkRepository, type AfkRow } from "../repositories/afk.js";
import { log } from "../core/logger.js";
import { safeBoldText, sanitizeEcho, truncate } from "../lib/validation.js";

export interface AfkStatus {
  reason: string;
  sinceUnixMs: number;
}

// Matches the DB CHECK constraint on afk.reason. Truncation happens
// AFTER escaping because safeBoldText EXPANDS text (each ** pair
// gains a zero-width char) — slicing first would let an escaped
// 200-char reason grow past the constraint and crash the insert.
const MAX_REASON_STORED = 200;

/**
 * In-memory index of WHO is currently AFK, per guild. The database
 * is the source of truth; this Set is a write-through cache so the
 * hot path (every message in every guild checks "is the author
 * AFK?") is a Map lookup instead of a SQL SELECT. Rebuilt from the
 * DB on startup and maintained on every set/clear.
 */
const afkIndex = new Map<string, Set<string>>(); // guildId -> userIds

function indexGet(guildId: string): Set<string> {
  let set = afkIndex.get(guildId);
  if (!set) {
    set = new Set();
    afkIndex.set(guildId, set);
  }
  return set;
}

/** Startup pass: rebuild the index from persisted rows. */
export function warmAfkIndex(): void {
  afkIndex.clear();
  for (const row of afkRepository.all()) {
    indexGet(row.guild_id).add(row.user_id);
  }
  log.debug("AFK", `AFK index warmed: ${afkRepository.count()} status(es) across ${afkIndex.size} guild(s).`);
}

/**
 * AFK service — per-guild status, persisted. Commands and the
 * messageCreate listener both go through here; nothing outside
 * touches the repository directly.
 */
export const afkService = {
  /** Cheap membership check for the per-message hot path. */
  isAfk(guildId: string, userId: string): boolean {
    const set = afkIndex.get(guildId);
    return set !== undefined && set.has(userId);
  },

  /** Whether this guild has ANY AFK users (mention-notice pre-check). */
  hasAnyAfk(guildId: string): boolean {
    const set = afkIndex.get(guildId);
    return set !== undefined && set.size > 0;
  },

  /** Drops a guild's index entry entirely (guildDelete cleanup). */
  dropGuildIndex(guildId: string): void {
    afkIndex.delete(guildId);
  },

  set(guildId: string, userId: string, rawReason: string): AfkStatus {
    // Escape first (text expands), THEN truncate to the stored cap so
    // the DB CHECK constraint can never be violated by expansion.
    // Invisible-only reasons sanitize to "" — an empty stored reason
    // would violate the CHECK (length <= 200 is fine, but the notice
    // would render "** **"), so fall back to the plain "AFK" marker.
    const shaped = truncate(safeBoldText(rawReason.trim() || "AFK"), MAX_REASON_STORED);
    const reason = sanitizeEcho(shaped).trim() ? shaped : "AFK";
    const sinceUnixMs = Date.now();
    afkRepository.set(guildId, userId, reason, sinceUnixMs);
    indexGet(guildId).add(userId);
    log.info("AFK", `Set AFK for ${userId} in guild ${guildId}: ${JSON.stringify(reason)}`);
    return { reason, sinceUnixMs };
  },

  get(guildId: string, userId: string): AfkStatus | null {
    const row = afkRepository.get(guildId, userId);
    return row ? { reason: row.reason, sinceUnixMs: row.since_unix_ms } : null;
  },

  /** Clears status; returns how long they were away (or null if they weren't AFK). */
  clear(guildId: string, userId: string): { awayMs: number } | null {
    const row = afkRepository.get(guildId, userId);
    if (!row) return null;
    afkRepository.clear(guildId, userId);
    afkIndex.get(guildId)?.delete(userId);
    log.info("AFK", `Cleared AFK for ${userId} in guild ${guildId}.`);
    return { awayMs: Math.max(0, Date.now() - row.since_unix_ms) };
  },

  /** AFK statuses for a set of mentioned users (notice path). */
  forMentions(guildId: string, userIds: string[]): Map<string, AfkStatus> {
    const rows = afkRepository.getMany(guildId, userIds);
    return new Map(rows.map((r: AfkRow) => [r.user_id, { reason: r.reason, sinceUnixMs: r.since_unix_ms }]));
  },
};
