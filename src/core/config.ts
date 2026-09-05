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

/**
 * The prefix must be exactly ONE usable character. Multi-character
 * prefixes change how the dispatcher must tokenize (">>" vs "> >"),
 * whitespace prefixes are untypeable in practice, and "/" collides
 * with Discord's native slash commands. The bot refuses to start
 * with a clear reason instead of misbehaving at runtime.
 */
function validatePrefix(raw: string | undefined): string {
  const prefix = raw ?? ">";

  if (prefix.length !== 1) {
    throw new Error(
      `PREFIX exceeds the character limit — it must be exactly ONE character (got "${prefix}", ${prefix.length} characters). ` +
        `Edit PREFIX in your .env to a single character like >, !, ?, or $.`,
    );
  }
  if (/\s/.test(prefix)) {
    throw new Error(`PREFIX cannot be a whitespace character (got "${prefix}"). Pick something typeable like > or !.`);
  }
  if (prefix === "/") {
    throw new Error(
      `PREFIX cannot be "/" — that's reserved for Discord's native slash commands (moderation/admin/developer tools). Pick another character like > or !.`,
    );
  }

  return prefix;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Project root, whether running from src/core/ (tsx) or dist/core/ (compiled)
const projectRoot = path.resolve(__dirname, "..", "..");

export const config = {
  botName: "Syndicate Bot",
  version: "0.6.1-beta",
  author: "Ranajoy Roy",

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

  prefix: validatePrefix(process.env.PREFIX),

  // Consistent brand color used across every embed
  embedColor: 0x5865f2, // Discord blurple

  // Where the plain-text suggestions export/backup lives (the SQL
  // database is the authoritative store; this stays as a human-
  // readable mirror for easy skimming).
  suggestionsFile: path.join(projectRoot, "data", "suggestions.txt"),

  // SQLite database file (relative to project root). WAL journal
  // files (.wal/.shm) appear next to it at runtime.
  databaseFile: process.env.DATABASE_FILE || "data/syndicate.db",

  // ---- Local management dashboard (localhost only) ----
  // A browser UI for the bot's operator: manage jokes, 8-ball
  // responses, and suggestions, and reboot/shutdown the process.
  // Binds 127.0.0.1 ONLY — unreachable from the network by design;
  // exposing it requires an explicit, deliberate override and a
  // correctly-set password hash.
  dashboardEnabled: process.env.DASHBOARD_ENABLED === "true",
  dashboardHost: process.env.DASHBOARD_HOST || "127.0.0.1",
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 3721,
  // PBKDF2 hash of the dashboard password (format:
  // pbkdf2$<iterations>$<saltHex>$<hashHex>). Required to boot the
  // dashboard — never store or accept a plaintext password here.
  dashboardPasswordHash: process.env.DASHBOARD_PASSWORD_HASH || null,
  dashboardSessionTtlMs: 2 * 60 * 60 * 1000, // 2h session lifetime
} as const;
