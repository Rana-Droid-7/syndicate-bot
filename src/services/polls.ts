import type { Client, Message } from "discord.js";
import { pollRepository, type PollRow } from "../repositories/polls.js";
import { safeSetTimeout } from "../lib/safeTimeout.js";
import { baseEmbed } from "../lib/embeds.js";
import { UserInputError } from "../lib/errors.js";
import { isRateLimitError } from "../lib/rateLimit.js";
import { escapeMarkdownBold } from "../lib/validation.js";
import { log } from "../core/logger.js";

const SWEEP_INTERVAL_MS = 60_000; // periodic due-check, safety net for missed timers
// Cap on open polls per user per guild — same rationale as reminders'
// 25-cap: an unbounded queue is a timer bomb and DB growth without
// limit. 10 concurrent open polls per person is generous.
export const MAX_OPEN_PER_USER = 10;

// Set on shutdown: in-flight timers must not touch the closed DB.
let shuttingDown = false;
// Sweep plumbing (single interval per process — see startSweep).
let sweepInterval: ReturnType<typeof setInterval> | null = null;
let sweepClient: Client = null as unknown as Client;
// The client closePoll resolves channels/messages against. Timers
// capture the client that armed them in a closure — but a soft
// restart destroys that client and creates a fresh one in the SAME
// process, and a timer armed before the restart can fire after it.
// Resolving against this module-scoped reference (refreshed on every
// boot, restore included) instead of the closure makes those timers
// hit the LIVE client — the stale-client race that would otherwise
// terminally fail a healthy poll on a destroyed connection.
let activeClient: Client = null as unknown as Client;

/** Clears the shutdown flag for a soft restart (new client, same process). */
export function resetForRestart(): void {
  shuttingDown = false;
}

/**
 * Poll service. The DB row is the recap promise — the same contract as
 * reminders: a timer firing closes the poll and posts the recap; a
 * restart reschedules every open row; the row is the truth, the timer
 * is just the delivery optimization.
 *
 * Closing works via Discord's OFFICIAL End Poll endpoint
 * (POST /channels/{id}/messages/{id}/polls/expire — discord.js exposes
 * it as poll.end()), which is REQUIRED for decimal-hour durations:
 * Discord only schedules expiry in WHOLE hours at creation, so a 0.01h
 * (36s) poll must be ended early by us to honor the user's duration.
 * Polls with a whole-hour duration could expire on their own, but we
 * end every poll ourselves so the recap always follows immediately
 * after Discord's own final tally (results may be approximate while
 * live; ended polls always carry results).
 */
export const pollService = {
  /** Called on every shutdown path BEFORE the DB closes. */
  beginShutdown(): void {
    shuttingDown = true;
  },

  schedule(client: Client, row: PollRow): void {
    if (shuttingDown) return;
    const delay = Math.max(0, row.close_unix_ms - Date.now());
    log.info("TIMER", `Poll #${row.id} in guild ${row.guild_id} scheduled — closing in ${delay}ms.`);
    // unref'd: the Discord connection, not a pending poll timer, keeps
    // the live process alive — same rationale as reminder timers. The
    // callback resolves through activeClient, NOT the closure: a
    // soft restart replaces the client after this timer is armed.
    safeSetTimeout(
      () => {
        void closePoll(activeClient, row.id);
      },
      delay,
      undefined,
      { unref: true },
    );
  },

  /**
   * Cap pre-check — call BEFORE posting the poll message. The cap
   * itself lives in create() as the transactional enforcement point,
   * but a cap violation discovered there would leave an already-
   * posted poll with no recap promise: checking first means the user
   * gets the clean error before anything lands in the channel.
   */
  assertCanCreate(guildId: string, userId: string): void {
    if (pollRepository.openCountFor(guildId, userId) >= MAX_OPEN_PER_USER) {
      throw new UserInputError(
        `You already have ${MAX_OPEN_PER_USER} open polls here — let some finish first.`,
        'poll <hours> "<question>" "<option 1>", "<option 2>", ...',
      );
    }
  },

  async create(
    client: Client,
    guildId: string,
    channelId: string,
    messageId: string,
    userId: string,
    question: string,
    options: string[],
    closeUnixMs: number,
  ): Promise<number> {
    // First write after a soft restart may precede restore()'s refresh.
    activeClient = client;
    // Per-user cap: the row is a promise, but an unbounded queue of
    // open polls is a timer bomb and unbounded DB growth. (Enforced
    // here too — create() is the transactional authority; the command
    // pre-checks via assertCanCreate for the clean UX.)
    if (pollRepository.openCountFor(guildId, userId) >= MAX_OPEN_PER_USER) {
      // The dispatcher renders this as a clean usage-carrying error and
      // refunds the cooldown — must be the REAL taxonomy class.
      throw new UserInputError(
        `You already have ${MAX_OPEN_PER_USER} open polls here — let some finish first.`,
        'poll <hours> "<question>" "<option 1>", "<option 2>", ...',
      );
    }
    const id = pollRepository.create(guildId, channelId, messageId, userId, question, options, Date.now(), closeUnixMs);
    const row = pollRepository.get(id);
    if (row) this.schedule(client, row);
    else log.error("TIMER", `Poll #${id} vanished after insert — not scheduled.`);
    return id;
  },

  /** Startup pass: reschedule everything still open. */
  restore(client: Client): number {
    activeClient = client;
    const open = pollRepository.open();
    const now = Date.now();
    let overdue = 0;
    for (const row of open) {
      if (row.close_unix_ms <= now) overdue++;
      this.schedule(client, row);
    }
    if (open.length > 0) {
      log.info("TIMER", `Restored ${open.length} open poll(s) (${overdue} overdue — closing immediately).`);
    }
    return open.length;
  },

  /**
   * Periodic safety net — closes anything the timers somehow missed.
   * Idempotent per process (soft restart hands it the fresh client,
   * never a second interval) — the same discipline as the reminder
   * sweep.
   */
  startSweep(client: Client): void {
    sweepClient = client;
    activeClient = client;
    if (sweepInterval !== null) return;
    sweepInterval = setInterval(() => {
      if (shuttingDown) return;
      try {
        for (const row of pollRepository.due(Date.now())) {
          log.warn("TIMER", `Sweep found overdue poll #${row.id} — closing.`);
          void closePoll(sweepClient, row.id);
        }
      } catch {
        // DB closed between the shutdown flag and here — stand down.
        log.debug("TIMER", "Poll sweep skipped (storage unavailable).");
      }
    }, SWEEP_INTERVAL_MS);
    sweepInterval.unref();
  },
};

async function closePoll(client: Client, id: number): Promise<void> {
  // Shutdown in progress — the DB may already be closed. The row stays
  // open and the next startup's restore pass reschedules it, so the
  // recap is only ever DELAYED, never lost.
  if (shuttingDown) return;

  // In-flight guard: a timer's closePoll() and the sweep can race — a
  // close mid-end/post would otherwise be selected again and the recap
  // double-posted. Claimed synchronously before any await, released
  // after the row is terminal or intentionally left open for retry.
  if (closing.has(id)) return;
  closing.add(id);

  try {
    let poll: PollRow | null;
    try {
      poll = pollRepository.get(id);
    } catch (error) {
      // DB closed/unavailable between the check above and here — the
      // sweep on next boot handles it. Never crash the process.
      log.warn("TIMER", `Poll #${id} could not be read (storage closing?) — deferring to next startup.`, error);
      return;
    }
    if (!poll || poll.status !== "open") return;

    // Decode the options ONCE, before any Discord call: a corrupt row
    // (impossible through normal writes — every insert is
    // JSON.stringify of a validated array — but DB corruption is a
    // thing) must go TERMINAL, not spin: leaving it open would make
    // the 60s sweep retry a poison row forever.
    let options: string[];
    try {
      const parsed = JSON.parse(poll.options) as unknown;
      if (!Array.isArray(parsed) || parsed.some((o) => typeof o !== "string") || parsed.length < 2) {
        throw new Error("not an array of >=2 strings");
      }
      options = parsed;
    } catch (error) {
      log.error("TIMER", `Poll #${id} has a corrupt options payload — marking failed.`, error);
      pollRepository.markFailed(id);
      return;
    }

    // Snapshot the live client NOW: a soft restart between this line
    // and the end/recap below replaces activeClient — a failure on
    // the stale reference must stay open (the fresh boot's restore
    // reschedules it), not terminally fail a healthy poll.
    const closeClient = activeClient;
    const channel = await closeClient.channels.fetch(poll.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log.warn("TIMER", `Poll #${id} undeliverable — channel ${poll.channel_id} gone. Marking failed.`);
      pollRepository.markFailed(id);
      return;
    }

    // Fetch the poll message. 404/unknown-message = deleted poll:
    // nothing to end, nothing to recap — the promise is void, terminal.
    const message: Message | null = await channel.messages
      .fetch(poll.message_id)
      .catch(() => null);
    if (!message || !message.poll) {
      log.warn("TIMER", `Poll #${id} undeliverable — message ${poll.message_id} gone. Marking failed.`);
      pollRepository.markFailed(id);
      return;
    }

    try {
      // Official End Poll: flips the poll to ended and pins the final
      // tallies. "You cannot end polls from other users" — the bot
      // owns this poll, so its own end call is always legal. If the
      // poll already expired on its own (whole-hour duration that
      // reached Discord's own expiry first), end() throws
      // PollAlreadyExpired — locally (djs checks the poll's expiry
      // timestamp) or from the API — that's the success path, not an
      // error: the tally is final either way.
      await message.poll.end().catch((error: unknown) => {
        const e = error as { code?: string; message?: string } | null;
        const alreadyExpired =
          e?.code === "PollAlreadyExpired"
          || (e instanceof Error && /already expired/i.test(e.message));
        if (alreadyExpired) {
          log.info("TIMER", `Poll #${id} had already expired on its own — recapping the final tally.`);
          return null;
        }
        throw error;
      });
    } catch (error) {
      // Transient Discord failures (rate limit, network blip) must not
      // permanently kill the recap: stay open, the sweep retries. Only
      // hard errors (deleted poll/message/channel, perms) go terminal.
      if (isRateLimitError(error)) {
        log.warn("TIMER", `Poll #${id} end/recap hit a rate limit — staying open, the sweep will retry.`);
        return;
      }
      // The soft-restart window: a restart replaced the client
      // between the snapshot and now — this failure happened on a
      // dying connection; the row stays open and the fresh boot's
      // restore reschedules it. Reference comparison, not word-
      // matching (wording changes between discord.js versions).
      if (closeClient !== activeClient) {
        log.warn("TIMER", `Poll #${id} end failed on a replaced client (soft restart) — staying open.`);
        return;
      }
      log.error("TIMER", `Failed to close poll #${id}`, error);
      pollRepository.markFailed(id);
      return;
    }

    // Re-fetch the message AFTER ending: the end response carries the
    // ended poll, but fetching guarantees fresh answer counts (the
    // message in cache still holds the pre-end snapshot).
    const final = await message.fetch().catch(() => message);
    const recap = buildRecapEmbed(poll.question, options, final);
    try {
      await final.reply({
        embeds: [recap],
        // Official mention gating: the recap can ping only the poll's
        // author. The question/options text is sanitized at creation,
        // but allowedMentions is the structural guarantee — the same
        // defense reminder delivery uses.
        allowedMentions: { users: [poll.user_id] },
      });
      pollRepository.markClosed(id);
      log.info("TIMER", `Poll #${id} closed and recapped in channel ${poll.channel_id}.`);
    } catch (error) {
      if (isRateLimitError(error)) {
        log.warn("TIMER", `Poll #${id} recap send hit a rate limit — staying open, the sweep will retry.`);
        return;
      }
      if (closeClient !== activeClient) {
        log.warn("TIMER", `Poll #${id} recap failed on a replaced client (soft restart) — staying open.`);
        return;
      }
      log.error("TIMER", `Failed to post recap for poll #${id}`, error);
      pollRepository.markFailed(id);
    }
  } catch (error) {
    // The outer safety net: closePoll runs from fire-and-forget timer
    // callbacks (void closePoll(...)) — an escaping throw would be an
    // unhandledRejection. Every expected failure is handled above;
    // anything here (a terminal write racing the DB close, a mock
    // surface drifting from the real djs shape) is logged and the row
    // LEFT OPEN: the sweep/next boot retries it, which is strictly
    // safer than abandoning it or crashing the process.
    log.warn("TIMER", `Unexpected error closing poll #${id} — leaving it open for the sweep/next boot.`, error);
  } finally {
    // Release only after the row is terminal (closed/failed) — an
    // early exit without terminal status (storage closing, rate-limit
    // retry) releases so the sweep can pick the row up again.
    closing.delete(id);
  }
}

// IDs with a close attempt currently in flight. Module-scoped so timers
// and the sweep share the same view.
const closing = new Set<number>();

/**
 * Builds the final-results recap embed. Vote math is Discord's own:
 * the ended poll's answer counts are final (the API guarantees results
 * on ended polls). Ties report ALL winners. Percentages are relative
 * to TOTAL votes cast.
 *
 * Counts are mapped by the answers collection's ORDER, not by answer
 * id: Discord's docs explicitly say "we recommend against depending
 * on this sequence" for answer_id — but the collection preserves the
 * creation order of the answers we sent, and polls cannot gain or
 * lose answers after creation, so index order is the stable mapping.
 */
export function buildRecapEmbed(question: string, options: string[], message: Message) {
  const ordered = [...(message.poll?.answers.values() ?? [])];
  const counts = options.map((_, i) => ordered[i]?.voteCount ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);

  // Winner(s): the max count, strictly above zero — an all-zero poll
  // has no winner ("nobody voted").
  const maxCount = Math.max(...counts);
  const winners = maxCount > 0 ? options.filter((_, i) => counts[i] === maxCount) : [];
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  // Bold-wrap with the same escape every other echoed field uses —
  // a literal ** in an option/question would otherwise terminate the
  // bold early and break the recap's formatting.
  const bold = (t: string) => `**${escapeMarkdownBold(t)}**`;

  const lines = options.map((opt, i) => {
    const badge = counts[i] === maxCount && maxCount > 0 ? " 🏆" : "";
    return `${i + 1}. ${bold(opt)}${badge} — ${counts[i]} vote${counts[i] === 1 ? "" : "s"} (${pct(counts[i])}%)`;
  });

  const verdict =
    winners.length === 0
      ? "Nobody voted — the void wins this one."
      : winners.length === 1
        ? `${bold(winners[0])} won with ${maxCount} of ${total} vote${total === 1 ? "" : "s"} (${pct(maxCount)}%).`
        : `It's a tie between ${winners.map((w) => bold(w)).join(" and ")} at ${maxCount} vote${maxCount === 1 ? "" : "s"} each (${pct(maxCount)}%).`;

  return baseEmbed()
    .setTitle("📊 Poll Results")
    .setDescription(`${bold(question)}\n\n${lines.join("\n")}\n\n${verdict}`)
    .setFooter({ text: `${total} vote${total === 1 ? "" : "s"} in total • closed after the set duration` });
}
