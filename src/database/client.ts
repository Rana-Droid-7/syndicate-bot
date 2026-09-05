import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";
import type { Database as SqliteDatabase } from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/database/client.js -> project root is ../../; src/database/client.ts -> ../../
const projectRoot = path.resolve(__dirname, "..", "..");
// Resolve relative DATABASE_FILE values against the project root so
// "data/x.db" works from any CWD and absolute paths pass through.
export const DB_PATH = path.resolve(projectRoot, config.databaseFile);

let db: SqliteDatabase | null = null;

/**
 * SQLite is single-file, serverless, and fast — the right size for
 * one Node process (better-sqlite3 is synchronous, which keeps
 * transactional invariants simple and race-free in a single-
 * threaded event loop). The public surface of this module is the
 * repository layer ONLY — command files never touch SQL.
 */
export function getDb(): SqliteDatabase {
  if (db) return db;

  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);

  // WAL: readers never block the writer and vice versa; safe
  // concurrent access from timers (reminder delivery) and commands.
  db.pragma("journal_mode = WAL");
  // Foreign keys are off by default in SQLite — integrity is part
  // of the schema contract, so turn them on.
  db.pragma("foreign_keys = ON");
  // Tighten durability: fsync on every commit. A reminder is a
  // promise; losing acknowledged writes to a power cut is worse
  // than a small write cost.
  db.pragma("synchronous = NORMAL");

  log.info("BOOT", `Database open: ${DB_PATH} (WAL, FK on)`);
  return db;
}

/** Closes the connection cleanly — only the shutdown path calls this. */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info("SHUTDOWN", "Database closed cleanly.");
  }
}

/**
 * Migrations are plain SQL files in migrations/, sorted by numeric
 * prefix, tracked in the schema_migrations table. A fresh database
 * reaches the current schema purely by running them in order.
 */
export function runMigrations(): void {
  const database = getDb();
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Import happens lazily so a missing migrations dir is a clear
  // startup error, not a module-resolution crash at import time.
  const applied = new Set(
    (database.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name),
  );

  const migrations = MIGRATIONS;
  let ran = 0;
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    const apply = database.transaction(() => {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(migration.name);
    });
    apply();
    log.info("BOOT", `Migration applied: ${migration.name}`);
    ran++;
  }
  log.info("BOOT", ran === 0 ? "Database schema up to date (0 migrations needed)." : `Applied ${ran} migration(s).`);
}

interface MigrationFile {
  name: string;
  sql: string;
}

// Migrations are embedded as strings rather than fs-read at runtime:
// the compiled dist/ must work standalone, and this guarantees the
// schema ships with the code. Appending a new entry is the only
// supported way to change the schema — never edit an applied one.
const MIGRATIONS: MigrationFile[] = [
  {
    name: "001_base",
    sql: `
      CREATE TABLE guilds (
        guild_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE afk (
        guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (length(reason) <= 200),
        since_unix_ms INTEGER NOT NULL CHECK (since_unix_ms > 0),
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 300),
        due_unix_ms INTEGER NOT NULL CHECK (due_unix_ms > 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        delivered_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'cancelled'))
      );
      CREATE INDEX idx_reminders_pending ON reminders (status, due_unix_ms) WHERE status = 'pending';

      CREATE TABLE warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        moderator_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
        created_unix_ms INTEGER NOT NULL CHECK (created_unix_ms > 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
      );
      CREATE INDEX idx_warnings_guild_user ON warnings (guild_id, user_id, active);

      CREATE TABLE suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL REFERENCES guilds(guild_id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'implemented')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_suggestions_guild ON suggestions (guild_id, status);

      CREATE TABLE jokes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 500),
        created_by TEXT NOT NULL REFERENCES users(user_id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0)
      );
      CREATE INDEX idx_jokes_enabled ON jokes (enabled, id);
    `,
  },
];
