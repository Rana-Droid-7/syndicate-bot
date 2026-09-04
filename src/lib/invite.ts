import { PermissionFlagsBits } from "discord.js";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";

/**
 * The bot's invite URL, kept in ONE place so /invite, /bot, and /help
 * can all link to it and the permission scope can never drift between
 * them. Must stay in sync with what the bot's commands actually need.
 */
export function buildInviteUrl(): string {
  const permissions =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.KickMembers |
    PermissionFlagsBits.BanMembers |
    PermissionFlagsBits.ModerateMembers |
    PermissionFlagsBits.ManageMessages |
    PermissionFlagsBits.ManageChannels |
    PermissionFlagsBits.ChangeNickname |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.EmbedLinks |
    PermissionFlagsBits.ReadMessageHistory |
    PermissionFlagsBits.UseApplicationCommands;

  log.debug("CMD", `Built invite URL with permission bitmask ${permissions}.`);

  return (
    `https://discord.com/oauth2/authorize?client_id=${config.clientId}` +
    `&permissions=${permissions}&scope=bot%20applications.commands`
  );
}
