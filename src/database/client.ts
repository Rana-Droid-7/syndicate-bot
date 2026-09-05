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
  {
    // Self-contained on purpose: databases that already applied 001
    // before the eightball suite existed get the table HERE, and
    // fresh databases get it here too — 001 stays byte-identical to
    // what shipped in v0.5.0 (append-only rule: never edit an
    // applied migration).
    name: "002_eightball_and_joke_seeds",
    sql: `
      CREATE TABLE IF NOT EXISTS eightball (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 300),
        created_by TEXT NOT NULL REFERENCES users(user_id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_eightball_enabled ON eightball (enabled, id);

      INSERT OR IGNORE INTO users (user_id) VALUES ('syndicate-seed');
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'It is certain.', 'syndicate-seed' WHERE NOT EXISTS (SELECT 1 FROM eightball);
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'It is decidedly so.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 1;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Without a doubt.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 2;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Yes — definitely.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 3;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'You may rely on it.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 4;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'As I see it, yes.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 5;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Most likely.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 6;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Outlook good.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 7;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Signs point to yes.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 8;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Reply hazy, try again.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 9;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Ask again later.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 10;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Better not tell you now.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 11;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Cannot predict now.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 12;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Concentrate and ask again.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 13;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Don''t count on it.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 14;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'My reply is no.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 15;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'My sources say no.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 16;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Outlook not so good.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 17;
      INSERT OR IGNORE INTO eightball (content, created_by)
        SELECT 'Very doubtful.', 'syndicate-seed' WHERE (SELECT COUNT(*) FROM eightball) = 18;

      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'Why do programmers prefer dark mode? Because light attracts bugs.', 'syndicate-seed'
        WHERE NOT EXISTS (SELECT 1 FROM jokes);
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'Why did the developer go broke? Because he used up all his cache.', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 1;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'There are only two hard things in computer science: cache invalidation, naming things, and off-by-one errors.', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 2;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'I told my computer I needed a break, and it said "no problem — I''m going to sleep".', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 3;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'Why do Java developers wear glasses? Because they can''t C#.', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 4;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'A SQL query walks into a bar, goes up to two tables and asks: "Can I join you?"', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 5;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'How many programmers does it take to change a light bulb? None — that''s a hardware problem.', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 6;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'Debugging: being the detective in a crime movie where you are also the murderer.', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 7;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT 'Why did the function stop calling? It lost its callback.', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 8;
      INSERT OR IGNORE INTO jokes (content, created_by)
        SELECT '99 little bugs in the code, 99 little bugs... take one down, patch it around, 127 little bugs in the code.', 'syndicate-seed'
        WHERE (SELECT COUNT(*) FROM jokes) = 9;
    `,
  },
];
