import { getDb } from "../database/client.js";

/** Guild rows exist so child tables can FK-reference them with
 *  ON DELETE CASCADE — deleting a guild cascades away all of its
 *  AFK statuses, reminders, warnings, and suggestions. */
export const guildRepository = {
  ensure(guildId: string): void {
    getDb()
      .prepare(
        `INSERT INTO guilds (guild_id) VALUES (?)
         ON CONFLICT (guild_id) DO UPDATE SET updated_at = datetime('now')`,
      )
      .run(guildId);
  },

  /** Removes the guild row; FK cascades clean all child data. Returns rows changed. */
  remove(guildId: string): number {
    return getDb().prepare(`DELETE FROM guilds WHERE guild_id = ?`).run(guildId).changes;
  },
};
