import type { Client } from "discord.js";
import { flushLogSink } from "../core/logSink.js";
import { closeDb } from "../database/client.js";
import { reminderService } from "../services/reminders.js";
import { log } from "../core/logger.js";

/**
 * The single graceful-exit path, shared by every shutdown trigger
 * (/boot's DM panel and OS signals). Ordering is load-bearing and
 * must never drift between triggers: reminder timers stand down,
 * the log sink drains while the connection is alive, Discord
 * disconnects, and the DB closes LAST so in-flight deliveries can't
 * race the close.
 *
 * `reboot=true` exits non-zero so a process manager (PM2, systemd,
 * Docker restart policy) brings the bot back; `reboot=false` exits 0
 * and stays down until started manually.
 */
export async function gracefulExit(
  client: Client,
  opts: { reboot: boolean; reason: string; requestedBy?: string },
): Promise<never> {
  log.info("SHUTDOWN", `${opts.reboot ? "Reboot" : "Shutdown"} (${opts.reason})${opts.requestedBy ? ` by ${opts.requestedBy}` : ""} — destroying client and exiting.`);
  reminderService.beginShutdown();
  await flushLogSink().catch(() => null);
  await client.destroy().catch(() => null);
  closeDb();
  process.exit(opts.reboot ? 1 : 0);
}
