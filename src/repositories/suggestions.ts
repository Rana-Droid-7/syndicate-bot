import { getDb } from "../database/client.js";
import { ensureGuild, ensureUser } from "./shared.js";

export interface SuggestionRow {
  id: number;
  guild_id: string;
  author_id: string;
  content: string;
  status: string;
  created_at: string;
}

/**
 * Suggestions: SQL is authoritative, the data/suggestions.txt file
 * remains as a human-readable export written on every insert.
 */
export const suggestionRepository = {
  add(guildId: string, authorId: string, content: string): number {
    ensureGuild(guildId);
    ensureUser(authorId);
    return Number(
      getDb()
        .prepare(`INSERT INTO suggestions (guild_id, author_id, content) VALUES (?, ?, ?)`)
        .run(guildId, authorId, content).lastInsertRowid,
    );
  },

  /** Read path for the (upcoming) admin review workflow; the
   *  integration harness also verifies inserts through it. */
  forGuild(guildId: string, status?: string): SuggestionRow[] {
    if (status) {
      return getDb()
        .prepare(`SELECT * FROM suggestions WHERE guild_id = ? AND status = ? ORDER BY id DESC`)
        .all(guildId, status) as SuggestionRow[];
    }
    return getDb()
      .prepare(`SELECT * FROM suggestions WHERE guild_id = ? ORDER BY id DESC`)
      .all(guildId) as SuggestionRow[];
  },
};
