import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../core/logger.js";

/**
 * Single-instance lock.
 *
 * The audit sessions' most embarrassing incident: two dev instances
 * ran concurrently for hours, doubling every lifecycle announcement
 * and every mirrored log line. `setsid` relaunches, PM2, systemd, a
 * second terminal — any path that starts the bot twice produces two
 * gateways sharing one SQLite file and one token. This lock makes
 * that class of mistake IMPOSSIBLE: the second boot refuses to start
 * with a clear message naming the holder's PID.
 *
 * Stale-lock safety: a lock is only honored if the recorded PID is
 * ALIVE (process.kill(pid, 0) probe). A crashed/killed process
 * leaves a lock that the next boot reclaims silently — no manual
 * cleanup after a power cut or `kill -9`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.resolve(__dirname, "..", "..", "data", "bot.lock");

/** Is a process with this PID alive? (signal 0 = existence probe) */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = exists but owned by another user (still alive!);
    // ESRCH = no such process (dead — lock is stale).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Acquires the single-instance lock. Returns true on success; on
 * failure a LIVE holder exists and this process must not boot.
 */
export function acquireSingleInstanceLock(): boolean {
  try {
    if (existsSync(LOCK_PATH)) {
      const raw = readFileSync(LOCK_PATH, "utf8").trim();
      const holderPid = Number(raw);
      if (Number.isInteger(holderPid) && holderPid > 0 && isPidAlive(holderPid)) {
        log.error(
          "BOOT",
          `Refusing to start: another Syndicate Bot instance (PID ${holderPid}) is already running ` +
            `(lockfile: ${LOCK_PATH}). Two instances double-send every announcement and mirror line. ` +
            `Stop the other instance first — or remove the lockfile if that PID is wrong.`,
        );
        return false;
      }
      // Stale lock (dead PID) — reclaim it.
      log.info("BOOT", `Reclaimed stale lock from dead PID ${raw || "(empty)"}.`);
    }

    mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
    writeFileSync(LOCK_PATH, String(process.pid), "utf8");
    log.debug("BOOT", `Single-instance lock acquired (PID ${process.pid} -> ${LOCK_PATH}).`);
    return true;
  } catch (error) {
    // The lock must never PREVENT a legit boot on a weird filesystem —
    // degrade to unlocked with a loud warning rather than refusing.
    log.warn("BOOT", `Lockfile check failed (${(error as Error).message}) — continuing WITHOUT the single-instance guarantee.`);
    return true;
  }
}

/** Releases the lock on the graceful shutdown paths. */
export function releaseSingleInstanceLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const holderPid = Number(readFileSync(LOCK_PATH, "utf8").trim());
    // Only remove OUR lock — a raced second instance may own it now.
    if (holderPid === process.pid) {
      rmSync(LOCK_PATH);
      log.debug("SHUTDOWN", "Single-instance lock released.");
    }
  } catch {
    // Never let lock cleanup break a shutdown in progress.
  }
}
