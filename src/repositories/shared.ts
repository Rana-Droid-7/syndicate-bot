import { getDb } from "../database/client.js";

/**
 * Tiny shared helpers repositories use — parameter binding is always
 * positional so no user string is ever interpolated into SQL.
 */

/** Ensures the parent rows exist before a child row references them. */
export function ensureUser(userId: string): void {
  getDb()
    .prepare(
      `INSERT INTO users (user_id) VALUES (?)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = datetime('now')`,
    )
    .run(userId);
}

export function ensureGuild(guildId: string): void {
  getDb()
    .prepare(
      `INSERT INTO guilds (guild_id) VALUES (?)
       ON CONFLICT (guild_id) DO UPDATE SET updated_at = datetime('now')`,
    )
    .run(guildId);
}
