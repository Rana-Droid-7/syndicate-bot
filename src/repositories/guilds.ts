import { stmt } from "./shared.js";

/** Guild rows exist so child tables can FK-reference them with
 *  ON DELETE CASCADE — deleting a guild cascades away all of its
 *  AFK statuses, reminders, warnings, and suggestions. */
export const guildRepository = {
  /** Removes the guild row; FK cascades clean all child data. Returns rows changed. */
  remove(guildId: string): number {
    return stmt(`DELETE FROM guilds WHERE guild_id = ?`).run(guildId).changes;
  },
};
