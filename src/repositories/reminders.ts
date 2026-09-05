import { getDb } from "../database/client.js";
import { ensureGuild, ensureUser } from "./shared.js";

export interface ReminderRow {
  id: number;
  guild_id: string;
  channel_id: string;
  user_id: string;
  content: string;
  due_unix_ms: number;
  created_at: string;
  delivered_at: string | null;
  status: string;
}

/** Persistent reminders — restored and rescheduled on every startup. */
export const reminderRepository = {
  create(guildId: string, channelId: string, userId: string, content: string, dueUnixMs: number): number {
    ensureGuild(guildId);
    ensureUser(userId);
    return Number(
      getDb()
        .prepare(
          `INSERT INTO reminders (guild_id, channel_id, user_id, content, due_unix_ms) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(guildId, channelId, userId, content, dueUnixMs).lastInsertRowid,
    );
  },

  /** All pending reminders due at or before the given time. */
  due(nowUnixMs: number): ReminderRow[] {
    return getDb()
      .prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_unix_ms <= ? ORDER BY due_unix_ms`)
      .all(nowUnixMs) as ReminderRow[];
  },

  /** All pending reminders (startup restore pass). */
  pending(): ReminderRow[] {
    return getDb().prepare(`SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_unix_ms`).all() as ReminderRow[];
  },

  /** Pending reminders for one user in one guild (per-user cap check). */
  pendingCountFor(guildId: string, userId: string): number {
    return (
      getDb()
        .prepare(`SELECT COUNT(*) AS n FROM reminders WHERE guild_id = ? AND user_id = ? AND status = 'pending'`)
        .get(guildId, userId) as { n: number }
    ).n;
  },

  get(id: number): ReminderRow | null {
    return (getDb().prepare(`SELECT * FROM reminders WHERE id = ?`).get(id) as ReminderRow | undefined) ?? null;
  },

  markDelivered(id: number): void {
    getDb()
      .prepare(`UPDATE reminders SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`)
      .run(id);
  },

  markFailed(id: number): void {
    getDb().prepare(`UPDATE reminders SET status = 'failed', delivered_at = datetime('now') WHERE id = ?`).run(id);
  },
};
