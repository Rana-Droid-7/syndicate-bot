import { SyndicateClient } from "./core/client.js";
import { loadCommands } from "./handlers/commandHandler.js";
import { loadEvents } from "./handlers/eventHandler.js";
import { config } from "./core/config.js";
import { log } from "./core/logger.js";
import { announceOffline, sendDevLog } from "./lib/devlog.js";
import { baseEmbed } from "./lib/embeds.js";
import { errorDetail } from "./lib/safeError.js";
import { flushLogSink, initLogSink } from "./core/logSink.js";
import { closeDb, getDb, runMigrations } from "./database/client.js";
import { reminderService, resetForRestart as resetRemindersForRestart } from "./services/reminders.js";
import { pollService, resetForRestart as resetPollsForRestart } from "./services/polls.js";
import { warmAfkIndex } from "./services/afk.js";
import { registerRestartHook } from "./lib/restartHook.js";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "./lib/singleInstanceLock.js";

// Safety net: a single failed interaction/API call anywhere in the
// bot should never be able to take the whole process down. Every
// interactive collector should already catch its own errors, but
// this is the last line of defense for anything that slips through.
process.on("unhandledRejection", (reason) => {
  log.error("PROC", "Unhandled promise rejection (caught by global safety net, process continues)", reason);
});

// An UNCAUGHT EXCEPTION is different: by Node's own guidance the
// process may be in an undefined state afterwards (corrupted memory,
// half-finished async work, broken invariants). Continuing to serve
// every guild in that state risks silently wrong behavior, so we
// log it, notify the dev channel, and shut down cleanly — a
// process manager (PM2, systemd, Docker restart policy) brings the
// bot back in a known-good state.
let shutdownForCrashStarted = false;
process.on("uncaughtException", (error) => {
  if (shutdownForCrashStarted) return; // a second crash during shutdown — just bail out
  shutdownForCrashStarted = true;

  log.error("PROC", "Uncaught exception — attempting graceful shutdown before exiting", error);

  const client = globalThis.__syndicateClient;
  if (!client) {
    process.exit(1);
    return;
  }

  // Async cleanup — but the exit must not be held hostage by a hung
  // Discord connection either, so race it against a 5s deadline.
  // Ordering mirrors the graceful shutdown path: reminder timers
  // stand down, the log sink drains while the connection is alive,
  // Discord disconnects, and the DB closes LAST so in-flight
  // deliveries can't race the close.
  const cleanup = (async () => {
    releaseSingleInstanceLock();
    await sendDevLog(
      client,
      baseEmbed()
        .setTitle("💥 Uncaught Exception — Shutting Down")
        .setDescription(`A process manager (PM2, systemd, Docker) should restart the bot.\n\n\`\`\`${errorDetail(error)}\`\`\``),
    ).catch(() => null); // never let the devlog attempt block or crash the exit path
    await announceOffline(client, "Uncaught exception (crash)", null).catch(() => null);
    reminderService.beginShutdown();
    pollService.beginShutdown();
    await flushLogSink().catch(() => null);
    await client.destroy().catch(() => null);
    closeDb();
  })();

  const deadline = setTimeout(() => {
    log.error("PROC", "Graceful crash shutdown missed its 5s deadline — forcing exit.");
    process.exit(1);
  }, 5000);

  cleanup.finally(() => {
    clearTimeout(deadline);
    process.exit(1);
  });
});

// The crash handler above needs the client, but index.js isn't an
// ES module scope shared with it — stash it on globalThis instead.
declare global {
  // eslint-disable-next-line no-var
  var __syndicateClient: SyndicateClient | undefined;
}

/**
 * Boots ONE client instance end-to-end: create, load commands/events,
 * login, arm the mirror, restore reminders. Everything except the
 * once-per-process work (DB open/migrate, signal handlers, sweep
 * interval) so a soft restart can call it again with a fresh client.
 */
async function bootClient(): Promise<SyndicateClient> {
  const client = new SyndicateClient();
  globalThis.__syndicateClient = client;
  log.debug("BOOT", "Client instance created.");

  log.info("BOOT", "Loading commands...");
  await loadCommands(client);

  log.info("BOOT", "Loading events...");
  await loadEvents(client);

  log.info("BOOT", "Logging in to Discord...");
  await client.login(config.token);
  log.info("BOOT", "Login call completed — waiting for 'ready' event.");

  // Wire the verbose mirror feed to the private logs channel. From
  // this point on, every mirrored log line (command dispatches,
  // permission decisions, AFK changes, ...) flows there in batches.
  if (config.botLogChannelId) {
    initLogSink(client, config.botLogChannelId);
    log.info("BOOT", "Private bot-logs mirror armed.");
  }

  // Restore persisted reminders + hand the sweep the fresh client
  // (the interval itself is created once per process).
  const restored = reminderService.restore(client);
  reminderService.startSweep(client);
  if (restored > 0) log.info("BOOT", `Reminder subsystem online (${restored} pending).`);

  // Same contract for open polls: rows restored, close timers armed.
  const openPolls = pollService.restore(client);
  pollService.startSweep(client);
  if (openPolls > 0) log.info("BOOT", `Poll recap subsystem online (${openPolls} open).`);

  // Warm the in-memory AFK index from the database so the per-message
  // hot path never needs a SELECT before the first set/clear.
  warmAfkIndex();

  return client;
}

async function main() {
  // ---- single-instance lock: BEFORE anything else ----
  // A second live instance would double-send every announcement and
  // mirror line (the double-instance incident). Refuse to boot if a
  // live holder exists; silently reclaim stale locks from dead PIDs.
  if (!acquireSingleInstanceLock()) {
    process.exit(1);
  }

  log.info("BOOT", `Starting ${config.botName} v${config.version}...`);
  log.info("BOOT", `Prefix: "${config.prefix}" | Dev guild: ${config.devGuildId ?? "(none — using global commands)"}`);
  log.info("BOOT", `Developer IDs configured: ${config.developerIds.length}`);
  log.info("BOOT", `Dev log channel: ${config.devLogChannelId ?? "(not configured)"}`);
  log.info("BOOT", `Private bot-logs channel: ${config.botLogChannelId ?? "(not configured)"}`);

  // ---- database: open, migrate, verify — before anything else ----
  // Fail fast: a bot without its storage layer is not a bot.
  const database = getDb();
  runMigrations();
  const integrity = database.pragma("integrity_check", { simple: true });
  if (integrity !== "ok") {
    throw new Error(`Database integrity check failed: ${String(integrity)} — refusing to start.`);
  }
  log.info("BOOT", `Database integrity: ${String(integrity)}.`);

  // ---- signal handling: registered BEFORE the slow boot steps ----
  // Command loading, Discord login, and reminder/poll restore can each
  // take seconds; Ctrl+C during any of them previously fell through to
  // default SIGINT behavior (hard exit) with zero cleanup. The
  // handlers resolve the CURRENT client through a mutable binding — a
  // soft restart replaces the client, and the captured first-boot
  // reference would announce-offline/destroy a dead client while the
  // live one was never cleanly disconnected.
  let currentClient: SyndicateClient | null = null;
  let signalShutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (signalShutdownStarted) return; // second signal during shutdown — ignore
    signalShutdownStarted = true;

    const client = currentClient ?? globalThis.__syndicateClient;
    log.info("SHUTDOWN", `Received ${signal}, disconnecting cleanly...`);
    // Announce "going offline" to the dev-log channel BEFORE the
    // connection drops, so the message actually gets delivered.
    if (client) await announceOffline(client, `Received ${signal} (process signal)`, null).catch(() => null);
    // Stop reminder + poll timers before storage closes — in-flight
    // ones defer to the next startup's restore pass instead of
    // crashing.
    reminderService.beginShutdown();
    pollService.beginShutdown();
    // Drain any queued verbose-log lines while the connection is
    // still alive — no silent gaps in the private logs channel.
    await flushLogSink().catch(() => null);
    if (client) {
      try {
        await client.destroy();
        log.info("SHUTDOWN", "Client destroyed cleanly.");
      } catch (error) {
        log.error("SHUTDOWN", "Error while destroying client (exiting anyway)", error);
      }
    }
    // Close the database AFTER Discord is down: pending reminder
    // deliveries triggered by timers won't race the close.
    closeDb();
    releaseSingleInstanceLock();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT").catch((error) => {
      log.error("SHUTDOWN", "Unexpected error in shutdown handler", error);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM").catch((error) => {
      log.error("SHUTDOWN", "Unexpected error in shutdown handler", error);
      process.exit(1);
    });
  });

  // ---- soft-restart machinery (used by /boot's Reboot) ----
  // A soft restart tears down the Discord connection, creates a
  // FRESH client, and re-runs the boot sequence IN THE SAME PROCESS —
  // so it works under `npm run dev` and bare `node` alike. Under a
  // process manager nothing changes: the process still never exits
  // on Reboot, so there's no restart-loop interaction to worry about.
  // currentClient (not a captured const) is destroyed: on the SECOND
  // restart the first boot's captured reference would be
  // already-dead, and the still-live client from the first restart
  // would leak — two connected gateways on one token, the exact
  // double-instance incident the lock exists to prevent.
  let restarting = false;
  const softRestart = async (reason: string, requestedBy: string): Promise<void> => {
    if (restarting) return; // a second click racing the restart
    restarting = true;
    log.info("SHUTDOWN", `Soft restart (${reason}) by ${requestedBy} — recycling client in-process...`);

    // Stand down timers, drain the mirror queue while connected.
    reminderService.beginShutdown();
    pollService.beginShutdown();
    // Announce offline BEFORE the connection drops — every "Bot
    // Online" from the upcoming boot pairs with this embed in the
    // dev-log (ready.ts's pairing contract).
    if (currentClient) {
      await announceOffline(currentClient, `Soft restart (${reason})`, requestedBy).catch(() => null);
    }
    await flushLogSink().catch(() => null);

    const oldClient = currentClient;
    if (oldClient) {
      try {
        await oldClient.destroy();
        log.info("SHUTDOWN", "Old client destroyed cleanly.");
      } catch (error) {
        log.error("SHUTDOWN", "Error destroying old client (continuing restart)", error);
      }
      currentClient = null;
    }

    // DB stays open — same process, same connection. Just re-arm the
    // subsystems that stood down.
    resetRemindersForRestart();
    resetPollsForRestart();
    try {
      currentClient = await bootClient();
      log.info("BOOT", "Soft restart complete — bot is back online.");
    } catch (error) {
      log.error("BOOT", "Soft restart FAILED to bring the bot back up", error);
      // Couldn't come back: fall back to the classic contract — exit
      // non-zero so a process manager (PM2/systemd/Docker/tsx watch
      // with a wrapper) has the chance to revive the process.
      process.exit(1);
    }
    restarting = false;
  };

  // Exported for /boot via a module-level hook (commands can't reach
  // index.ts's closure directly).
  registerRestartHook((reason, requestedBy) => {
    void softRestart(reason, requestedBy);
  });

  // ---- the slow boot steps (signal handlers are already armed) ----
  currentClient = await bootClient();
}

main().catch((error) => {
  log.error("BOOT", "Failed to start bot", error);
  process.exit(1);
});
