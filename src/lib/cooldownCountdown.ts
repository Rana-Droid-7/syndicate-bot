import type { EmbedBuilder } from "discord.js";
import { baseEmbed, errorEmbed } from "./embeds.js";
import { discordTimestamp } from "./format.js";
import { log } from "../core/logger.js";

/**
 * Dynamic cooldown countdown.
 *
 * The old rendering baked "try again in **4s**" into the error at
 * THROW time — by the time the user read it, the number was already
 * wrong. This renderer shows LIVE remaining time:
 *
 *  - a Discord dynamic timestamp (<t:expiry:R>) that Discord itself
 *    re-renders second-by-second in every client — the countdown
 *    stays live even if every subsequent edit fails; and
 *  - a progress-bar edit loop: the message is edited once per second
 *    with a shrinking bar (▰▰▱▱) and the live count, then flips to a
 *    "ready" state exactly at expiry.
 *
 * Never throws, never blocks the dispatcher: the edit loop is
 * fire-and-forget with .catch-swallowed failures (a deleted message
 * or missing perms just freezes the last visible state — the <t:R>
 * tag keeps counting regardless), and the interval self-clears at
 * expiry so nothing leaks. All timers are unref'd — the shutdown
 * paths never wait on a countdown.
 */

const BAR_SEGMENTS = 8;
const EDIT_INTERVAL_MS = 1_000;
/** After the "ready" flip, one last edit sticks around this long. */
const READY_LINGER_MS = 15_000;

/** edit abstraction: prefix messages and slash replies both expose .edit. */
export interface CountdownTarget {
  edit: (payload: { embeds: unknown[] }) => Promise<unknown>;
}

function progressBar(remainingMs: number, totalMs: number): string {
  const fraction = totalMs > 0 ? 1 - remainingMs / totalMs : 1; // elapsed fraction
  const filled = Math.min(BAR_SEGMENTS, Math.max(0, Math.round(fraction * BAR_SEGMENTS)));
  return "▰".repeat(filled) + "▱".repeat(BAR_SEGMENTS - filled);
}

/** The countdown embed's description for a given remaining time. */
function countdownDescription(commandLabel: string, remainMs: number, totalMs: number, expiryUnix: number): string {
  if (remainMs > 0) {
    return (
      `You're using **${commandLabel}** too quickly — live countdown:\n\n` +
      `${progressBar(remainMs, totalMs)}  **${(remainMs / 1000).toFixed(1)}s** left\n\n` +
      `Ready ${discordTimestamp(expiryUnix, "R")} — the bar and the counter update live.`
    );
  }
  return `**${commandLabel}** is ready to use again — go ahead.`;
}

/** The FIRST reply embed: error-colored, live-countdown content. */
export function cooldownCountdownEmbed(commandLabel: string, remainingMs: number, totalMs: number): EmbedBuilder {
  const expiryUnix = Math.floor((Date.now() + remainingMs) / 1000);
  return errorEmbed(countdownDescription(commandLabel, remainingMs, totalMs, expiryUnix));
}

/**
 * Runs the live countdown on an ALREADY-SENT message, editing it once
 * per second until the window clears. Returns immediately; ticking
 * happens in the background.
 *
 * @param target edit callback for the sent message
 * @param commandLabel display name of the command (e.g. ">joke" or "/ban")
 * @param remainingMs cooldown remaining at send time
 * @param totalMs the command's full cooldown window
 */
export function startCooldownCountdown(
  target: CountdownTarget,
  commandLabel: string,
  remainingMs: number,
  totalMs: number,
): void {
  const expiryUnix = Math.floor((Date.now() + remainingMs) / 1000);
  const totalTicks = Math.ceil(remainingMs / EDIT_INTERVAL_MS);
  let tick = 0;

  const timer = setInterval(() => {
    tick++;
    const remain = Math.max(0, remainingMs - tick * EDIT_INTERVAL_MS);

    Promise.resolve(
      target.edit({
        // After the window clears the embed flips to brand color and
        // the "ready" message — the user sees the exact moment.
        embeds: [
          (remain > 0
            ? errorEmbed(countdownDescription(commandLabel, remain, totalMs, expiryUnix))
            : baseEmbed().setDescription(countdownDescription(commandLabel, 0, totalMs, expiryUnix))
          ),
        ],
      }),
    ).catch(() => {
      // Message deleted / perms changed mid-countdown — stop updates
      // silently; the <t:R> tag keeps ticking in whatever state the
      // message was last left in.
      clearInterval(timer);
    });

    // Stop after the "ready" flip + a short linger so the final state
    // stays visible without editing forever.
    if (tick >= totalTicks + Math.ceil(READY_LINGER_MS / EDIT_INTERVAL_MS)) {
      clearInterval(timer);
      log.debug("PREFIX", `Cooldown countdown for ${commandLabel} completed.`);
    }
  }, EDIT_INTERVAL_MS);

  timer.unref?.();
}
