import type { Client, TextBasedChannel } from "discord.js";

/**
 * Private bot-logs channel sink.
 *
 * The console logger stays the source of truth; this module MIRRORS
 * a filtered feed of those log lines into a private Discord channel
 * (BOT_LOG_CHANNEL_ID). Verbose-but-non-critical operational info —
 * command dispatches, permission checks, AFK changes, timer
 * scheduling, help lookups — flows here so the bot's behavior is
 * observable live from Discord, without drowning the console in
 * INFO logs or requiring SSH access.
 *
 * Design constraints (this must never hurt the bot):
 *  - NEVER blocks or throws: enqueue() is synchronous, delivery is
 *    a background flush with .catch-swallowed errors.
 *  - Batched: lines accumulate for up to FLUSH_INTERVAL ms and are
 *    sent as one message wrapped in a code block. Keeps the channel
 *    readable and stays far under Discord's rate limits.
 *  - Thresholded: if a batch grows past MAX_QUEUE before the
 *    interval elapses, it flushes early. Failed batches are dropped
 *    (a failing mirror must never loop into more logging).
 *  - Critical lifecycle events (online/offline/crash) still go
 *    through devlog.ts embeds — this sink is for the VERBOSE feed.
 */

const MAX_QUEUE = 40; // hard cap before an emergency flush
const FLUSH_INTERVAL_MS = 5_000;
const MAX_BATCH_CHARS = 1850; // 2000-char message limit minus wrapper
// Safety net: if one flush ever somehow produced more sends than
// this, drop the rest instead of hammering a struggling API.
const MAX_SENDS_PER_FLUSH = 5;

interface SinkState {
  queue: string[];
  timer: NodeJS.Timeout | null;
  client: Client | null;
  channelId: string | null;
  totalSent: number;
  /** Cached channel object — fetch once, reuse until it breaks. */
  channel: TextBasedChannel | null;
  /** Back off temporarily after a delivery failure. */
  pausedUntil: number;
}

const state: SinkState = {
  queue: [],
  timer: null,
  client: null,
  channelId: null,
  totalSent: 0,
  channel: null,
  pausedUntil: 0,
};

export function initLogSink(client: Client, channelId: string): void {
  state.client = client;
  state.channelId = channelId;
}

function emergencyFlush(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  void flush();
}

function flush(): Promise<void> {
  if (state.queue.length === 0 || !state.client || !state.channelId) {
    return Promise.resolve();
  }

  // A recent delivery failed — drop this batch and stand down briefly
  // (mirroring logs must never retry-loop into a struggling API).
  if (Date.now() < state.pausedUntil) {
    state.queue = [];
    return Promise.resolve();
  }

  const lines = state.queue;
  state.queue = [];

  // Chunk lines into ≤MAX_BATCH_CHARS batches (one send per chunk).
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > MAX_BATCH_CHARS) {
      if (current.length > 0) chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);

  const sendAll = async () => {
    // Fetch the channel once per flush and reuse it — one REST call
    // per batch instead of per chunk.
    const channel = state.channel ?? (await state.client!.channels.fetch(state.channelId!).catch(() => null));
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      state.channel = null;
      state.pausedUntil = Date.now() + 60_000;
      return;
    }
    state.channel = channel;

    let sent = 0;
    for (const chunk of chunks) {
      if (sent >= MAX_SENDS_PER_FLUSH) break; // drop the tail, never flood
      const body = chunk.join("\n").slice(0, MAX_BATCH_CHARS);
      await channel.send({ content: `\`\`\`\n${body}\n\`\`\`` });
      state.totalSent += chunk.length;
      sent++;
    }
  };

  return sendAll().catch(() => {
    // Delivery failed (missing channel, perms, outage). Back off and
    // drop the batch — mirroring logs must never loop back into more
    // logging or crash anything.
    state.channel = null;
    state.pausedUntil = Date.now() + 60_000;
  });
}

/**
 * Queue one log line for the private channel. Tags decide what
 * reaches the channel at all (see shouldMirror below) — the sink
 * deliberately does NOT mirror ERROR/CONFIRM-style noise that
 * already gets proper dev-log embeds.
 */
export function enqueueMirror(tag: string, level: string, message: string): void {
  if (!state.client && !state.channelId) return; // sink not wired yet
  if (!shouldMirror(tag, level)) return;

  const stamp = new Date().toISOString().slice(11, 19); // HH:MM:SS
  // The mirror is the leak surface: command args, reasons, and
  // expressions ride inside log messages. Strip control characters
  // and censor token-shaped secrets before the line ever queues.
  const safeMessage = sanitizeMirrorLine(message);
  state.queue.push(`${stamp} [${level}] [${tag}] ${safeMessage}`.slice(0, 190));

  if (state.queue.length > MAX_QUEUE) emergencyFlush();
  else if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const TOKEN_SHAPE = /(?:Bot\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g;

function sanitizeMirrorLine(message: string): string {
  return message.replace(CONTROL_CHARS, "").replace(TOKEN_SHAPE, "[redacted]");
}

/** Tags worth mirroring to the private logs channel. */
const MIRRORED_TAGS = new Set([
  "BOOT",
  "CMD",
  "COOLSIES",
  "PREFIX",
  "EVENT",
  "PERM",
  "MOD",
  "ADMIN",
  "OWNER",
  "TIMER",
  "AFK",
  "WARN",
  "SUGGEST",
  "SHUTDOWN",
  "HELP",
  "DEPLOY",
  "CALC",
  "DEVLOG",
  "BANNER",
]);

function shouldMirror(tag: string, level: string): boolean {
  // DEBUG stays console-only: it's the firehose. Everything else
  // mirrored above flows to the channel.
  if (level === "DEBUG") return false;
  if (!MIRRORED_TAGS.has(tag)) return false;
  return true;
}

/** Drain any queued lines now — used on graceful shutdown paths. */
export async function flushLogSink(): Promise<void> {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  await flush();
}
