import { getDb } from "../database/client.js";
import { ensureUser } from "./shared.js";

export interface EightBallRow {
  id: number;
  content: string;
  created_by: string;
  created_at: string;
  updated_at: string | null;
  enabled: number;
  usage_count: number;
}

/**
 * 8-ball responses. Same shape as jokes: random SQL-side selection
 * with the usage counter bumped in one transaction; every mutation is
 * developer-only and validated in the service layer.
 */
export const eightBallRepository = {
  add(content: string, createdBy: string): number {
    ensureUser(createdBy);
    return Number(
      getDb().prepare(`INSERT INTO eightball (content, created_by) VALUES (?, ?)`).run(content, createdBy)
        .lastInsertRowid,
    );
  },

  /** One random enabled response, with its usage counter bumped. */
  randomWithUsage(): EightBallRow | null {
    const database = getDb();
    const run = database.transaction(() => {
      const row = database
        .prepare(`SELECT * FROM eightball WHERE enabled = 1 ORDER BY RANDOM() LIMIT 1`)
        .get() as EightBallRow | undefined;
      if (row) {
        database.prepare(`UPDATE eightball SET usage_count = usage_count + 1 WHERE id = ?`).run(row.id);
      }
      return row ?? null;
    });
    return run();
  },

  countEnabled(): number {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM eightball WHERE enabled = 1`).get() as { n: number }).n;
  },

  countAll(): number {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM eightball`).get() as { n: number }).n;
  },

  list(limit = 25, offset = 0): EightBallRow[] {
    return getDb()
      .prepare(`SELECT * FROM eightball ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as EightBallRow[];
  },

  get(id: number): EightBallRow | null {
    return (getDb().prepare(`SELECT * FROM eightball WHERE id = ?`).get(id) as EightBallRow | undefined) ?? null;
  },

  remove(id: number): boolean {
    return getDb().prepare(`DELETE FROM eightball WHERE id = ?`).run(id).changes > 0;
  },

  edit(id: number, content: string): boolean {
    return (
      getDb()
        .prepare(`UPDATE eightball SET content = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(content, id).changes > 0
    );
  },

  setEnabled(id: number, enabled: boolean): boolean {
    return (
      getDb()
        .prepare(`UPDATE eightball SET enabled = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(enabled ? 1 : 0, id).changes > 0
    );
  },
};
