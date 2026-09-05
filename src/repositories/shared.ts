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

/**
 * Removes users with no remaining references in any child table.
 * FK cascades delete afk/reminders/warnings/suggestions rows when a
 * guild goes, but nothing cleans the parent `users` rows — over
 * months of joins/leaves they'd accumulate forever. Called from the
 * guildDelete cleanup path.
 */
export function pruneOrphanedUsers(): number {
  return getDb()
    .prepare(
      `DELETE FROM users WHERE user_id NOT IN (SELECT user_id FROM afk)
       AND user_id NOT IN (SELECT user_id FROM reminders)
       AND user_id NOT IN (SELECT user_id FROM warnings)
       AND user_id NOT IN (SELECT author_id FROM suggestions)
       AND user_id NOT IN (SELECT created_by FROM jokes)
       AND user_id NOT IN (SELECT moderator_id FROM warnings)`,
    )
    .run().changes;
}
