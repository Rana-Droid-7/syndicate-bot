import { log } from "../core/logger.js";

// Node/V8's setTimeout uses a 32-bit SIGNED int internally. Any
// delay above this doesn't error — it silently fires almost
// immediately instead (confirmed empirically: a ~24.86-day delay
// fired after 1ms, with Node's own TimeoutOverflowWarning). Since
// we want to support delays up to 30 days, we can't just call
// setTimeout(fn, delayMs) directly for the long ones.
const DEFAULT_MAX_HOP_MS = 2_147_483_647; // 2^31 - 1, ~24.855 days

/**
 * Like setTimeout, but safe for delays longer than ~24.86 days.
 * For delays under the safe limit, behaves identically to a plain
 * setTimeout. For longer delays, chains through intermediate
 * safe-sized timers until the real delay has elapsed, then fires
 * the callback exactly once.
 *
 * The max hop size is injectable so verify_timer.mjs can exercise
 * the CHAINED path with small, fast hops in CI — the real bug
 * (fires-in-1ms-instead-of-waiting) lived entirely in the hop
 * arithmetic, not in the single-shot passthrough.
 */
export function safeSetTimeout(
  callback: () => void,
  delayMs: number,
  maxHopMs: number = DEFAULT_MAX_HOP_MS,
): void {
  if (delayMs <= maxHopMs) {
    log.debug("TIMER", `Scheduling timer for ${delayMs}ms (within safe range).`);
    setTimeout(callback, delayMs);
    return;
  }

  // Chain one hop; recurse with whatever remains. If the remainder
  // is itself still over the hop limit, the recursion continues.
  const remaining = delayMs - maxHopMs;
  log.debug(
    "TIMER",
    `Delay ${delayMs}ms exceeds the safe hop limit (${maxHopMs}ms) — chaining. ` +
      `Scheduling an intermediate ${maxHopMs}ms hop, ${remaining}ms will remain after that.`,
  );

  setTimeout(() => {
    log.debug("TIMER", `Intermediate hop elapsed, ${remaining}ms remaining — rescheduling.`);
    safeSetTimeout(callback, remaining, maxHopMs);
  }, maxHopMs);
}
