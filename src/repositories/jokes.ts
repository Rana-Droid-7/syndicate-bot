import { stmt } from "./shared.js";
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
      stmt(`INSERT INTO jokes (content, created_by) VALUES (?, ?)`).run(
        content,
        createdBy,
      ).lastInsertRowid,
    );
  },

  /** One random enabled joke, with its usage counter bumped. */
  randomWithUsage(): JokeRow | null {
    const database = getDb();
    // Both statements ride the shared stmt() cache — the transaction
    // wraps their EXECUTION, not their compilation (compiling once
    // per process is safe: prepared statements are re-invoked inside
    // transactions, and closeDb() invalidates the cache wholesale).
    const run = database.transaction(() => {
      const row = stmt(
        `SELECT * FROM jokes WHERE enabled = 1 ORDER BY RANDOM() LIMIT 1`,
      ).get() as JokeRow | undefined;
      if (row) {
        stmt(`UPDATE jokes SET usage_count = usage_count + 1 WHERE id = ?`).run(row.id);
      }
      return row ?? null;
    });
    return run();
  },

  countEnabled(): number {
    return (
      stmt(`SELECT COUNT(*) AS n FROM jokes WHERE enabled = 1`).get() as {
        n: number;
      }
    ).n;
  },

  countAll(): number {
    return (stmt(`SELECT COUNT(*) AS n FROM jokes`).get() as { n: number }).n;
  },

  list(limit = 25, offset = 0): JokeRow[] {
    return stmt(`SELECT * FROM jokes ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset) as JokeRow[];
  },

  get(id: number): JokeRow | null {
    return (
      (stmt(`SELECT * FROM jokes WHERE id = ?`).get(id) as
        JokeRow | undefined) ?? null
    );
  },

  remove(id: number): boolean {
    return stmt(`DELETE FROM jokes WHERE id = ?`).run(id).changes > 0;
  },

  edit(id: number, content: string): boolean {
    return (
      stmt(`UPDATE jokes SET content = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(content, id).changes > 0
    );
  },

  setEnabled(id: number, enabled: boolean): boolean {
    return (
      stmt(`UPDATE jokes SET enabled = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(enabled ? 1 : 0, id).changes > 0
    );
  },
};
