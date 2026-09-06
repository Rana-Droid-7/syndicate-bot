import { stmt } from "./shared.js";
import { ensureGuild, ensureUser } from "./shared.js";

export interface AfkRow {
  guild_id: string;
  user_id: string;
  reason: string;
  since_unix_ms: number;
}

/** Per-guild AFK status — keyed (guild, user), never global. */
export const afkRepository = {
  set(
    guildId: string,
    userId: string,
    reason: string,
    sinceUnixMs: number,
  ): void {
    ensureGuild(guildId);
    ensureUser(userId);
    stmt(
      `INSERT INTO afk (guild_id, user_id, reason, since_unix_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = excluded.reason, since_unix_ms = excluded.since_unix_ms`,
    ).run(guildId, userId, reason, sinceUnixMs);
  },

  get(guildId: string, userId: string): AfkRow | null {
    return (
      (stmt(`SELECT * FROM afk WHERE guild_id = ? AND user_id = ?`).get(
        guildId,
        userId,
      ) as AfkRow | undefined) ?? null
    );
  },

  clear(guildId: string, userId: string): boolean {
    return (
      stmt(`DELETE FROM afk WHERE guild_id = ? AND user_id = ?`).run(
        guildId,
        userId,
      ).changes > 0
    );
  },

  /** All AFK rows (startup index warm). */
  all(): AfkRow[] {
    return stmt(`SELECT * FROM afk`).all() as AfkRow[];
  },

  count(): number {
    return (stmt(`SELECT COUNT(*) AS n FROM afk`).get() as { n: number }).n;
  },

  /** All AFK users in a guild whose ID appears in the given set. */
  getMany(guildId: string, userIds: string[]): AfkRow[] {
    if (userIds.length === 0) return [];
    const placeholders = userIds.map(() => "?").join(", ");
    return stmt(
      `SELECT * FROM afk WHERE guild_id = ? AND user_id IN (${placeholders})`,
    ).all(guildId, ...userIds) as AfkRow[];
  },
};
