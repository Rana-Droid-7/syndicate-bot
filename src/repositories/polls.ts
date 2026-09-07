import { stmt, ensureGuild, ensureUser } from "./shared.js";

/** Options are stored as a JSON array of sanitized strings. */
export interface PollRow {
  id: number;
  guild_id: string;
  channel_id: string;
  message_id: string;
  user_id: string;
  question: string;
  /** JSON-encoded string[] — the poll's answer texts, sanitized. */
  options: string;
  created_unix_ms: number;
  close_unix_ms: number;
  closed_at: string | null;
  status: string;
}

/**
 * Native-poll recap tracking. A row is the promise that a poll the bot
 * posted will get its final-tally recap — the same contract reminders
 * have: timers alone die with a crash or restart, the row is restored
 * on every boot. All SQL lives here; services own the lifecycle.
 */
export const pollRepository = {
  create(
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    question: string,
    options: string[],
    createdUnixMs: number,
    closeUnixMs: number,
  ): number {
    ensureGuild(guildId);
    ensureUser(userId);
    return Number(
      stmt(
        `INSERT INTO polls (guild_id, channel_id, message_id, user_id, question, options, created_unix_ms, close_unix_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .run(guildId, channelId, messageId, userId, question, JSON.stringify(options), createdUnixMs, closeUnixMs)
        .lastInsertRowid,
    );
  },

  /** All open polls due to close at or before the given time. */
  due(nowUnixMs: number): PollRow[] {
    return stmt(`SELECT * FROM polls WHERE status = 'open' AND close_unix_ms <= ? ORDER BY close_unix_ms`)
      .all(nowUnixMs) as PollRow[];
  },

  /** All open polls (startup restore pass). */
  open(): PollRow[] {
    return stmt(`SELECT * FROM polls WHERE status = 'open' ORDER BY close_unix_ms`).all() as PollRow[];
  },

  /** Open polls for one user in one guild (per-user cap check). */
  openCountFor(guildId: string, userId: string): number {
    return (
      stmt(`SELECT COUNT(*) AS n FROM polls WHERE guild_id = ? AND user_id = ? AND status = 'open'`).get(
        guildId,
        userId,
      ) as { n: number }
    ).n;
  },

  get(id: number): PollRow | null {
    return (stmt(`SELECT * FROM polls WHERE id = ?`).get(id) as PollRow | undefined) ?? null;
  },

  markClosed(id: number): void {
    stmt(`UPDATE polls SET status = 'closed', closed_at = datetime('now') WHERE id = ?`).run(id);
  },

  markFailed(id: number): void {
    stmt(`UPDATE polls SET status = 'failed', closed_at = datetime('now') WHERE id = ?`).run(id);
  },

  /**
   * Retention: terminal polls (closed/failed) whose close time is
   * past the retention window — same rationale as reminder retention.
   */
  purgeTerminal(olderThanUnixMs: number): number {
    return stmt(`DELETE FROM polls WHERE status IN ('closed', 'failed') AND close_unix_ms < ?`)
      .run(olderThanUnixMs).changes;
  },
};
