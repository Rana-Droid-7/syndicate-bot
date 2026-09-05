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
import { reminderService } from "./services/reminders.js";
import { warmAfkIndex } from "./services/afk.js";

// Safety net: a single failed interaction/API call anywhere in the
// bot should never be able to take the whole process down. Every
// interactive collector should already catch its own errors, but
// this is the last line of defense for anything that slips through.
process.on("unhandledRejection", (reason) => {
  log.error("BOOT", "Unhandled promise rejection (caught by global safety net, process continues)", reason);
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

  log.error("BOOT", "Uncaught exception — attempting graceful shutdown before exiting", error);

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
    await sendDevLog(
      client,
      baseEmbed()
        .setTitle("💥 Uncaught Exception — Shutting Down")
        .setDescription(`A process manager (PM2, systemd, Docker) should restart the bot.\n\n\`\`\`${errorDetail(error)}\`\`\``),
    ).catch(() => null); // never let the devlog attempt block or crash the exit path
    await announceOffline(client, "Uncaught exception (crash)", null).catch(() => null);
    reminderService.beginShutdown();
    await flushLogSink().catch(() => null);
    await client.destroy().catch(() => null);
    closeDb();
  })();

  const deadline = setTimeout(() => {
    log.error("BOOT", "Graceful crash shutdown missed its 5s deadline — forcing exit.");
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

async function main() {
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

  const client = new SyndicateClient();
  globalThis.__syndicateClient = client;
  log.debug("BOOT", "Client instance created.");

  // ---- signal handling: registered BEFORE the slow boot steps ----
  // Command loading, Discord login, and reminder restore can each
  // take seconds; Ctrl+C during any of them previously fell through
  // to default SIGINT behavior (hard exit) with zero cleanup.
  let signalShutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (signalShutdownStarted) return; // second signal during shutdown — ignore
    signalShutdownStarted = true;

    log.info("SHUTDOWN", `Received ${signal}, disconnecting cleanly...`);
    // Announce "going offline" to the dev-log channel BEFORE the
    // connection drops, so the message actually gets delivered.
    await announceOffline(client, `Received ${signal} (process signal)`, null).catch(() => null);
    // Stop reminder timers before storage closes — in-flight ones
    // defer to the next startup's restore pass instead of crashing.
    reminderService.beginShutdown();
    // Drain any queued verbose-log lines while the connection is
    // still alive — no silent gaps in the private logs channel.
    await flushLogSink().catch(() => null);
    try {
      await client.destroy();
      log.info("SHUTDOWN", "Client destroyed cleanly.");
    } catch (error) {
      log.error("SHUTDOWN", "Error while destroying client (exiting anyway)", error);
    }
    // Close the database AFTER Discord is down: pending reminder
    // deliveries triggered by timers won't race the close.
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      log.error("SHUTDOWN", "Unexpected error in shutdown handler", error);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      log.error("SHUTDOWN", "Unexpected error in shutdown handler", error);
      process.exit(1);
    });
  });

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

  // Restore persisted reminders + start the overdue sweep safety net.
  const restored = reminderService.restore(client);
  reminderService.startSweep(client);
  if (restored > 0) log.info("BOOT", `Reminder subsystem online (${restored} pending).`);

  // Warm the in-memory AFK index from the database so the per-message
  // hot path never needs a SELECT before the first set/clear.
  warmAfkIndex();
}

main().catch((error) => {
  log.error("BOOT", "Failed to start bot", error);
  process.exit(1);
});
