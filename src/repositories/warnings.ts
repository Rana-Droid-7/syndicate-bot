import { getDb } from "../database/client.js";
import { ensureGuild, ensureUser } from "./shared.js";

export interface WarningRow {
  id: number;
  guild_id: string;
  user_id: string;
  moderator_id: string;
  reason: string;
  created_unix_ms: number;
  active: number;
}

// Soft cap per user per guild. Warnings roll the oldest off beyond
// this — recent ones are what matter for moderation decisions, and
// an unbounded list would eventually overflow any display.
export const MAX_WARNINGS_PER_USER = 25;

export const warningRepository = {
  add(guildId: string, userId: string, moderatorId: string, reason: string, createdUnixMs: number): number {
    ensureGuild(guildId);
    ensureUser(userId);
    ensureUser(moderatorId);

    const insert = getDb().prepare(
      `INSERT INTO warnings (guild_id, user_id, moderator_id, reason, created_unix_ms) VALUES (?, ?, ?, ?, ?)`,
    );
    // Delete the oldest beyond the cap. Ordering must be fully
    // deterministic: rapid-fire inserts share a timestamp down to
    // the millisecond, so id (autoincrement, monotonic) is the
    // tie-breaker — without it, SQLite's ambiguous ordering can keep
    // "r28" as newest while deleting r29.
    const prune = getDb().prepare(
      `DELETE FROM warnings WHERE id IN (
         SELECT id FROM warnings
         WHERE guild_id = ? AND user_id = ? AND active = 1
         ORDER BY created_unix_ms DESC, id DESC
         LIMIT -1 OFFSET ?
       )`,
    );

    // Insert + cap enforcement atomically: a moderator spamming
    // /warn add concurrently can never end up over the cap.
    const run = getDb().transaction(() => {
      insert.run(guildId, userId, moderatorId, reason, createdUnixMs);
      prune.run(guildId, userId, MAX_WARNINGS_PER_USER);
    });
    run();

    return this.countActive(guildId, userId);
  },

  countActive(guildId: string, userId: string): number {
    return (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1`)
        .get(guildId, userId) as { n: number }
    ).n;
  },

  /** Total active warnings across all guilds (dashboard status card). */
  totalActive(): number {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM warnings WHERE active = 1`).get() as { n: number }).n;
  },

  activeFor(guildId: string, userId: string): WarningRow[] {
    return getDb()
      .prepare(
        `SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? AND active = 1
         ORDER BY created_unix_ms DESC, id DESC`,
      )
      .all(guildId, userId) as WarningRow[];
  },

  clearActive(guildId: string, userId: string): number {
    return getDb()
      .prepare(`UPDATE warnings SET active = 0 WHERE guild_id = ? AND user_id = ? AND active = 1`)
      .run(guildId, userId).changes;
  },
};
