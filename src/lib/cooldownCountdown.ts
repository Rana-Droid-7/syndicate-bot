import type { EmbedBuilder } from "discord.js";
import { baseEmbed, errorEmbed } from "./embeds.js";
import { discordTimestamp } from "./format.js";
import { log } from "../core/logger.js";

/**
 * Live cooldown countdown — deliberately minimal, per spec:
 *
 *   "You are using >command too fast, try again in <t:R>"   (official
 *   Discord dynamic timestamp — Discord re-renders it live in every
 *   client, on its own, with zero edits needed)
 *
 *   then, when the window clears, ONE edit flips the whole message:
 *
 *   "You can use >command again now."
 *
 * No progress bars, no per-second edit loops — the countdown lives in
 * Discord's own <t:R> tag; the bot only performs the single final
 * edit. Unref'd timer, self-clearing, failures swallowed (if the
 * final edit dies, the <t:R> tag has already naturally expired and
 * reads "0 seconds ago" — still correct).
 */

/** The error embed shown when the cooldown hits. */
export function cooldownCountdownEmbed(commandLabel: string, remainingMs: number): EmbedBuilder {
  const expiryUnix = Math.floor((Date.now() + remainingMs) / 1000);
  return errorEmbed(
    `You are using **${commandLabel}** too fast, try again in ${discordTimestamp(expiryUnix, "R")}.`,
  );
}

/** The final state after the window clears. */
function readyEmbed(commandLabel: string): EmbedBuilder {
  return baseEmbed().setDescription(`You can use **${commandLabel}** again now.`);
}

/** edit abstraction: prefix messages and slash replies both expose .edit. */
export interface CountdownTarget {
  edit: (payload: { embeds: unknown[] }) => Promise<unknown>;
}

/**
 * Schedules the single "ready" flip: after `remainingMs`, edit the
 * message to the ready state. Returns immediately.
 */
export function startCooldownCountdown(
  target: CountdownTarget,
  commandLabel: string,
  remainingMs: number,
): void {
  const timer = setTimeout(() => {
    Promise.resolve(target.edit({ embeds: [readyEmbed(commandLabel)] })).catch(() => {
      // Message deleted / perms gone — the <t:R> tag already expired
      // naturally; nothing further to do.
      log.debug("PREFIX", "Cooldown ready-flip edit failed — ignored.");
    });
  }, Math.max(0, remainingMs));
  timer.unref?.();
}
