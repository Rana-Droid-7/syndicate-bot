import { getDb } from "../database/client.js";
import { ensureUser } from "./shared.js";

export interface JokeRow {
  id: number;
  content: string;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  enabled: number;
  usage_count: number;
}

/**
 * Jokes. Random selection is done in SQL (ORDER BY RANDOM() LIMIT 1)
 * so the whole collection never needs to be loaded into memory —
 * 5 jokes or 5000, one indexed lookup either way.
 */
export const jokeRepository = {
  add(content: string, createdBy: string): number {
    ensureUser(createdBy);
    return Number(
      getDb().prepare(`INSERT INTO jokes (content, created_by) VALUES (?, ?)`).run(content, createdBy).lastInsertRowid,
    );
  },

  /** One random enabled joke, with its usage counter bumped. */
  randomWithUsage(): JokeRow | null {
    const database = getDb();
    const run = database.transaction(() => {
      const row = database
        .prepare(`SELECT * FROM jokes WHERE enabled = 1 ORDER BY RANDOM() LIMIT 1`)
        .get() as JokeRow | undefined;
      if (row) {
        database.prepare(`UPDATE jokes SET usage_count = usage_count + 1 WHERE id = ?`).run(row.id);
      }
      return row ?? null;
    });
    return run();
  },

  countEnabled(): number {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM jokes WHERE enabled = 1`).get() as { n: number }).n;
  },

  countAll(): number {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM jokes`).get() as { n: number }).n;
  },

  list(limit = 25, offset = 0): JokeRow[] {
    return getDb()
      .prepare(`SELECT * FROM jokes ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as JokeRow[];
  },

  get(id: number): JokeRow | null {
    return (getDb().prepare(`SELECT * FROM jokes WHERE id = ?`).get(id) as JokeRow | undefined) ?? null;
  },

  remove(id: number): boolean {
    return getDb().prepare(`DELETE FROM jokes WHERE id = ?`).run(id).changes > 0;
  },

  edit(id: number, content: string): boolean {
    return (
      getDb()
        .prepare(`UPDATE jokes SET content = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(content, id).changes > 0
    );
  },

  setEnabled(id: number, enabled: boolean): boolean {
    return (
      getDb()
        .prepare(`UPDATE jokes SET enabled = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(enabled ? 1 : 0, id).changes > 0
    );
  },
};
