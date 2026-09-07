import type { Client } from "discord.js";
import { reminderRepository, type ReminderRow } from "../repositories/reminders.js";
import { pollRepository } from "../repositories/polls.js";
import { warningRepository } from "../repositories/warnings.js";
import { safeSetTimeout } from "../lib/safeTimeout.js";
import { UserInputError } from "../lib/errors.js";
import { isRateLimitError } from "../lib/rateLimit.js";
import { log } from "../core/logger.js";

// Last retention pass (see startSweep) — starts at 0 so the first
// sweep after boot runs one immediately (catching rows that aged out
// while the bot was down).
let lastRetentionPass = 0;

const SWEEP_INTERVAL_MS = 60_000; // periodic due-check, safety net for missed timers
// Retention cadence: terminal rows are purged hourly rather than
// every sweep — the purge is a range DELETE over indexed status
// columns, cheap enough, but there's no reason to run it 1440x/day.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // keep terminal rows 30 days
// Cap on pending reminders per user per guild — without one, a 5s
// cooldown still allows ~17k/day and every row becomes a boot timer.
export const MAX_PENDING_PER_USER = 25;

// Set on shutdown: in-flight timers must not touch the closed DB.
let shuttingDown = false;
// Sweep plumbing (single interval per process — see startSweep).
let sweepInterval: ReturnType<typeof setInterval> | null = null;
let sweepClient: Client = null as unknown as Client;
// The client deliver() resolves channels against. Timers capture the
// client that armed them in a closure — but a soft restart destroys
// that client and creates a fresh one in the SAME process, and a
// timer armed before the restart can fire after it. Resolving against
// this module-scoped reference (refreshed on every boot/restore)
// instead of the closure makes those timers hit the LIVE client —
// the stale-client race that would otherwise terminally fail a
// healthy reminder on a destroyed connection (the same fix polls
// already carries).
let activeClient: Client = null as unknown as Client;

/** Clears the shutdown flag for a soft restart (new client, same process). */
export function resetForRestart(): void {
  shuttingDown = false;
}

/**
 * Reminder service. DB rows are the source of truth: a timer firing
 * delivers and marks the row; a restart reschedules every pending
 * row from the database. Timers alone could be lost to a crash —
 * the row is the promise.
 */
export const reminderService = {
  /** Called on every shutdown path BEFORE the DB closes. */
  beginShutdown(): void {
    shuttingDown = true;
  },

  schedule(client: Client, row: ReminderRow): void {
    if (shuttingDown) return;
    const delay = Math.max(0, row.due_unix_ms - Date.now());
    log.info("TIMER", `Reminder #${row.id} for ${row.user_id} scheduled — firing in ${delay}ms.`);
    // unref'd: the Discord connection, not a pending reminder timer,
    // keeps the live process alive — and one-shot harnesses can exit
    // without waiting out a stray reminder. The callback resolves
    // through activeClient, NOT the closure: a soft restart replaces
    // the client after this timer is armed.
    safeSetTimeout(
      () => {
        void deliver(activeClient, row.id);
      },
      delay,
      undefined,
      { unref: true },
    );
  },

  async create(
    client: Client,
    guildId: string,
    channelId: string,
    userId: string,
    content: string,
    dueUnixMs: number,
  ): Promise<number> {
    // Per-user cap: reminders are a promise, but an unbounded queue is
    // a timer bomb (every pending row becomes a boot timer) and DB
    // growth without limit. 25 concurrent reminders is plenty for any
    // sane human use.
    if (reminderRepository.pendingCountFor(guildId, userId) >= MAX_PENDING_PER_USER) {
      // The REAL taxonomy class — the dispatchers (error mapping,
      // cooldown refund) and the help system all use instanceof, so
      // a plain Error with a faked name would degrade to the generic
      // "Something went wrong" and devlog-spam.
      throw new UserInputError(
        `You already have ${MAX_PENDING_PER_USER} pending reminders — let some fire (or deliver) first.`,
        'remindme "<time>" <what>',
      );
    }
    const id = reminderRepository.create(guildId, channelId, userId, content, dueUnixMs);
    // First write after a soft restart may precede restore()'s refresh.
    activeClient = client;
    const row = reminderRepository.get(id);
    if (row) this.schedule(client, row);
    else log.error("TIMER", `Reminder #${id} vanished after insert — not scheduled.`);
    return id;
  },

  /** Startup pass: reschedule everything still pending. */
  restore(client: Client): number {
    activeClient = client;
    const pending = reminderRepository.pending();
    const now = Date.now();
    let overdue = 0;
    for (const row of pending) {
      if (row.due_unix_ms <= now) overdue++;
      this.schedule(client, row);
    }
    if (pending.length > 0) {
      log.info("TIMER", `Restored ${pending.length} pending reminder(s) (${overdue} overdue — firing immediately).`);
    }
    return pending.length;
  },

  /**
   * Periodic safety net — delivers anything the timers somehow missed.
   * Idempotent per process: a soft restart (see index.ts) calls this
   * again with the fresh client; a second interval would double-log
   * every sweep and re-race deliveries, so the interval is created
   * exactly once and only the client reference moves to the new one.
   */
  startSweep(client: Client): void {
    sweepClient = client;
    activeClient = client;
    if (sweepInterval !== null) return;
    sweepInterval = setInterval(() => {
      if (shuttingDown) return;
      try {
        for (const row of reminderRepository.due(Date.now())) {
          log.warn("TIMER", `Sweep found overdue reminder #${row.id} — delivering.`);
          void deliver(sweepClient, row.id);
        }
        // Retention pass (hourly): terminal reminder/poll/warning rows
        // past the 30-day window are deleted so the tables (and the
        // `users` rows they reference) don't grow forever. Rows in
        // terminal status have already kept (or voided) their promise.
        if (Date.now() - lastRetentionPass >= RETENTION_INTERVAL_MS) {
          lastRetentionPass = Date.now();
          const cutoff = Date.now() - RETENTION_WINDOW_MS;
          const r = reminderRepository.purgeTerminal(cutoff);
          const p = pollRepository.purgeTerminal(cutoff);
          const w = warningRepository.purgeInactive(cutoff);
          if (r + p + w > 0) {
            log.info("TIMER", `Retention pass: purged ${r} terminal reminder(s), ${p} terminal poll(s), ${w} inactive warning(s) older than 30 days.`);
          }
        }
      } catch {
        // DB closed between the shutdown flag and here — stand down.
        log.debug("TIMER", "Sweep skipped (storage unavailable).");
      }
    }, SWEEP_INTERVAL_MS);
    sweepInterval.unref();
  },
};

async function deliver(client: Client, id: number): Promise<void> {
  // Shutdown in progress — the DB may already be closed. The row
  // stays pending and the next startup's restore pass reschedules
  // it, so nothing is lost by standing down here.
  if (shuttingDown) return;

  // In-flight guard: a timer's deliver() and the sweep can race —
  // the sweep re-selects every still-pending due row every 60s, so
  // a delivery that's mid-send (channel fetch, Discord round-trip,
  // a rate-limit backoff) would otherwise be selected AGAIN and the
  // user double-pinged. The guard is claimed synchronously before
  // any await and only released after the row reaches a terminal
  // status, so exactly one delivery attempt can ever run per id.
  if (delivering.has(id)) return;
  delivering.add(id);

  try {
    let reminder: ReminderRow | null;
    try {
      reminder = reminderRepository.get(id);
    } catch (error) {
      // DB closed/unavailable between the check above and here — the
      // sweep on next boot handles it. Never crash the process.
      log.warn("TIMER", `Reminder #${id} could not be read (storage closing?) — deferring to next startup.`, error);
      return;
    }
    if (!reminder || reminder.status !== "pending") return;

    // Snapshot the live client NOW: a soft restart between this line
    // and the send below replaces activeClient — a failure on the
    // stale reference must stay pending (the fresh boot's restore
    // reschedules it), not terminally fail a deliverable reminder.
    const deliveryClient = activeClient;
    const channel = await deliveryClient.channels.fetch(reminder.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log.warn("TIMER", `Reminder #${id} undeliverable — channel ${reminder.channel_id} gone. Marking failed.`);
      reminderRepository.markFailed(id);
      return;
    }

    try {
      // allowedMentions (official Discord feature): the ONLY ping this
      // delivery can produce is the reminder's owner. The stored text
      // may contain raw user mentions the author typed — without this
      // gate, a crafted reminder could ping anyone days later.
      await channel.send({
        content: `⏰ <@${reminder.user_id}>, reminder: **${reminder.content}**`,
        allowedMentions: { users: [reminder.user_id] },
      });
      reminderRepository.markDelivered(id);
      log.info("TIMER", `Delivered reminder #${id} to ${reminder.user_id} in channel ${reminder.channel_id}.`);
    } catch (error) {
      // A Discord rate limit (429) is TRANSIENT — e.g. a boot-time
      // burst of overdue reminders. Marking the row failed would
      // permanently kill a reminder that only needed a retry. Leave
      // it pending: the 60s sweep picks it up again once the window
      // clears. Only hard errors (missing perms, deleted surface) go
      // terminal.
      if (isRateLimitError(error)) {
        log.warn("TIMER", `Reminder #${id} hit a rate limit — staying pending, the sweep will retry.`);
        return;
      }
      // The soft-restart window: if a restart replaced the client
      // between the snapshot above and now, this failure happened on
      // a DYING connection — the row stays pending and the fresh
      // boot's restore pass reschedules it. Deterministic reference
      // comparison, not error-message word-matching (wording changes
      // between discord.js versions — the lesson of the 429 cycle).
      if (deliveryClient !== activeClient) {
        log.warn("TIMER", `Reminder #${id} send failed on a replaced client (soft restart) — staying pending.`);
        return;
      }
      log.error("TIMER", `Failed to deliver reminder #${id}`, error);
      reminderRepository.markFailed(id);
    }
  } finally {
    // Release only after the row is terminal (delivered/failed) — if
    // deliver() exited early WITHOUT reaching a terminal status (e.g.
    // the row vanished mid-flight), releasing lets the sweep retry
    // it rather than stranding it pending-but-unguarded forever.
    delivering.delete(id);
  }
}

// IDs with a delivery attempt currently in flight. Module-scoped so
// timers and the sweep share the same view.
const delivering = new Set<number>();
