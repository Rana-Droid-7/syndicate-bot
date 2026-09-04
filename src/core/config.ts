import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root, whether running from src/core/ (tsx) or dist/core/ (compiled)
const projectRoot = path.resolve(__dirname, "..", "..");

export const config = {
  botName: "Syndicate Bot",
  version: "0.5.0-beta",

  token: requireEnv("DISCORD_TOKEN"),
  clientId: requireEnv("CLIENT_ID"),
  devGuildId: process.env.DEV_GUILD_ID || null,
  ownerId: process.env.OWNER_ID || null,

  // Discord USER IDs (not roles) allowed to run owner/developer
  // commands. Checked in code against the invoking user's ID —
  // this is global across every server the bot is in, so it must
  // never be gated by a per-server role. OWNER_ID is always
  // included automatically.
  developerIds: [
    ...(process.env.OWNER_ID ? [process.env.OWNER_ID] : []),
    ...(process.env.DEVELOPER_IDS
      ? process.env.DEVELOPER_IDS.split(",").map((id) => id.trim()).filter(Boolean)
      : []),
  ],

  // Optional channel ID (in your own server) that receives
  // operational logs: guild joins/leaves, command errors, restarts,
  // and the online/offline lifecycle announcements.
  devLogChannelId: process.env.DEV_LOG_CHANNEL_ID || null,

  // Optional PRIVATE channel that receives the verbose operational
  // feed: every command dispatch, permission decision, AFK change,
  // timer, etc. Mirrored from the central logger in batches.
  botLogChannelId: process.env.BOT_LOG_CHANNEL_ID || null,

  prefix: process.env.PREFIX || ">",

  // Consistent brand color used across every embed
  embedColor: 0x5865f2, // Discord blurple

  // Where the plain-text suggestions export/backup lives (the SQL
  // database is the authoritative store; this stays as a human-
  // readable mirror for easy skimming).
  suggestionsFile: path.join(projectRoot, "data", "suggestions.txt"),

  // SQLite database file (relative to project root). WAL journal
  // files (.wal/.shm) appear next to it at runtime.
  databaseFile: process.env.DATABASE_FILE || "data/syndicate.db",
} as const;
