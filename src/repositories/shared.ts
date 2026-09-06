import { getDb } from "../database/client.js";
import type { Statement } from "better-sqlite3";

/**
 * Tiny shared helpers repositories use — parameter binding is always
 * positional so no user string is ever interpolated into SQL.
 */

/**
 * Prepared-statement cache. Every repository query goes through here:
 * the SQL string is compiled to a prepared statement ONCE per process
 * and reused on every call — previously every getDb().prepare(...)
 * re-parsed the SQL on every single invocation (every message's AFK
 * check, every random joke pull, every warning add).
 *
 * The cache lives as long as the connection: closeDb() invalidates it
 * wholesale (and a fresh getDb() reopens with an empty map — a stale
 * statement object would reference the old closed connection).
 */
const statementCache = new Map<string, Statement>();

/** Drop every cached statement — called by closeDb() only. */
export function clearStatementCache(): void {
  statementCache.clear();
}

/** Cached prepare: same semantics as db.prepare(), compiled once. */
export function stmt(sql: string): Statement {
  let s = statementCache.get(sql);
  if (s === undefined) {
    s = getDb().prepare(sql);
    statementCache.set(sql, s);
  }
  return s;
}

/** Ensures the parent rows exist before a child row references them. */
export function ensureUser(userId: string): void {
  stmt(
    `INSERT INTO users (user_id) VALUES (?)
     ON CONFLICT (user_id) DO UPDATE SET updated_at = datetime('now')`,
  ).run(userId);
}

export function ensureGuild(guildId: string): void {
  stmt(
    `INSERT INTO guilds (guild_id) VALUES (?)
     ON CONFLICT (guild_id) DO UPDATE SET updated_at = datetime('now')`,
  ).run(guildId);
}

/**
 * Removes users with no remaining references in any child table.
 * FK cascades delete afk/reminders/warnings/suggestions rows when a
 * guild goes, but nothing cleans the parent `users` rows — over
 * months of joins/leaves they'd accumulate forever. Called from the
 * guildDelete cleanup path.
 */
export function pruneOrphanedUsers(): number {
  return stmt(
    `DELETE FROM users WHERE user_id NOT IN (SELECT user_id FROM afk)
     AND user_id NOT IN (SELECT user_id FROM reminders)
     AND user_id NOT IN (SELECT user_id FROM warnings)
     AND user_id NOT IN (SELECT author_id FROM suggestions)
     AND user_id NOT IN (SELECT created_by FROM jokes)
     AND user_id NOT IN (SELECT created_by FROM eightball)
     AND user_id NOT IN (SELECT moderator_id FROM warnings)`,
  ).run().changes;
}
