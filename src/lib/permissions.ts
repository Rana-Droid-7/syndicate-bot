import { PermissionFlagsBits, type GuildMember } from "discord.js";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";

/**
 * True if this Discord user ID is a trusted bot developer.
 *
 * This is the ONLY correct way to gate process-control commands
 * (restart, stop, etc). It is deliberately independent of Discord
 * roles/permissions: the bot is global across every server it's
 * in, so a role granted by some other server's admin must never
 * be able to control it. Always check this in code — never rely
 * on a slash command's default_member_permissions alone, since
 * that's a UI convenience, not a security boundary.
 */
export function isDeveloper(userId: string): boolean {
  const result = config.developerIds.includes(userId);
  log.debug("PERM", `isDeveloper(${userId}) -> ${result}`);
  return result;
}

/**
 * True if this member has the Administrator permission in this
 * specific server. Unlike isDeveloper(), this is intentionally
 * server-scoped — Admin commands only affect the guild they're
 * run in (announcements, bot nickname, slowmode), so gating by
 * Discord's own permission system is the correct, standard tool
 * here. Still checked in code (not just via the slash command's
 * default_member_permissions) because server admins can override
 * command visibility per-channel in Integrations settings, and
 * prefix (">") commands get no Discord-side enforcement at all.
 */
export function isAdmin(member: GuildMember): boolean {
  const result = member.permissions.has(PermissionFlagsBits.Administrator);
  log.debug("PERM", `isAdmin(${member.id} in guild ${member.guild.id}) -> ${result}`);
  return result;
}

export interface ModerationCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validates that `actor` is allowed to moderate `target` in this
 * guild, and that the bot itself is able to carry out the action.
 * Centralizes every hierarchy/identity edge case so kick/ban/timeout
 * can't be used to act on the wrong person or escalate privilege:
 *  - can't target yourself
 *  - can't target the bot
 *  - can't target the server owner
 *  - can't target someone with an equal/higher role than you
 *    (unless you ARE the server owner)
 *  - the bot's own role must be positioned above the target's
 */
export function canModerate(
  actor: GuildMember,
  target: GuildMember,
  botMember: GuildMember,
): ModerationCheckResult {
  log.debug(
    "MOD",
    `canModerate check: actor=${actor.id} (top role pos ${actor.roles.highest.position}), ` +
      `target=${target.id} (top role pos ${target.roles.highest.position}), ` +
      `bot=${botMember.id} (top role pos ${botMember.roles.highest.position}), ` +
      `guildOwner=${target.guild.ownerId}`,
  );

  if (target.id === actor.id) {
    log.warn("MOD", `canModerate DENY: ${actor.id} attempted to target themselves.`);
    return { ok: false, reason: "You can't target yourself." };
  }
  if (target.id === botMember.id) {
    log.warn("MOD", `canModerate DENY: ${actor.id} attempted to target the bot.`);
    return { ok: false, reason: "I can't target myself." };
  }
  if (target.id === target.guild.ownerId) {
    log.warn("MOD", `canModerate DENY: ${actor.id} attempted to target the server owner ${target.id}.`);
    return { ok: false, reason: "You can't moderate the server owner." };
  }
  if (actor.id !== target.guild.ownerId && target.roles.highest.position >= actor.roles.highest.position) {
    log.warn(
      "MOD",
      `canModerate DENY: ${actor.id} (pos ${actor.roles.highest.position}) tried to target ${target.id} ` +
        `(pos ${target.roles.highest.position}) — equal/higher role.`,
    );
    return { ok: false, reason: "You can't moderate someone with an equal or higher role than you." };
  }
  if (target.roles.highest.position >= botMember.roles.highest.position) {
    log.warn(
      "MOD",
      `canModerate DENY: bot's top role (pos ${botMember.roles.highest.position}) is not above target ${target.id} ` +
        `(pos ${target.roles.highest.position}).`,
    );
    return {
      ok: false,
      reason: "My role is positioned below theirs (or equal) — I can't act on them. Move my role higher in Server Settings.",
    };
  }

  log.info("MOD", `canModerate ALLOW: ${actor.id} may act on ${target.id}.`);
  return { ok: true };
}
