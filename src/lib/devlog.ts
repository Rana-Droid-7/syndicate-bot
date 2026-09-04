import type { Client, EmbedBuilder } from "discord.js";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";
import { baseEmbed } from "./embeds.js";

/**
 * Posts an embed to a channel by ID, with the same never-throw
 * guarantees as sendDevLog. Used by the lifecycle announcements,
 * which live in the private bot-logs channel (the operational feed)
 * rather than the dev-log channel (reserved for errors and
 * attention-worthy events).
 */
async function sendChannelEmbed(client: Client, channelId: string, embed: EmbedBuilder, label: string): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId).catch((err) => {
      log.error("DEVLOG", `Failed to fetch ${label} channel ${channelId}`, err);
      return null;
    });
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log.warn("DEVLOG", `${label} channel ${channelId} is missing, not text-based, or not sendable.`);
      return false;
    }
    await channel.send({ embeds: [embed] });
    log.debug("DEVLOG", `Sent ${label} message to channel ${channelId}.`);
    return true;
  } catch (error) {
    log.error("DEVLOG", `Failed to send ${label} message`, error);
    return false;
  }
}

/**
 * Posts an embed to the configured DEV_LOG_CHANNEL_ID, if set.
 * Silently no-ops if unconfigured, the channel can't be found, or
 * the bot lacks permission — this must never throw and take down
 * whatever operation triggered the log (an error handler that
 * itself errors is a classic way to crash a bot).
 */
export async function sendDevLog(client: Client, embed: EmbedBuilder): Promise<void> {
  if (!config.devLogChannelId) {
    log.debug("DEVLOG", "DEV_LOG_CHANNEL_ID not configured — skipping.");
    return;
  }
  await sendChannelEmbed(client, config.devLogChannelId, embed, "dev log");
}

/**
 * Lifecycle announcements (online/offline). These belong in the
 * private bot-logs channel — the operational feed — so anyone
 * watching that channel sees the bot's lifecycle alongside the
 * verbose mirror. Falls back to the dev-log channel if the
 * bot-logs channel isn't configured, so an announcement is never
 * silently lost; if neither is configured, no-op.
 *
 * Posted on every startup/shutdown path (boot ready, SIGINT/
 * SIGTERM, crash, and /boot panel actions).
 */
async function sendLifecycleAnnouncement(client: Client, embed: EmbedBuilder): Promise<void> {
  if (config.botLogChannelId) {
    const sent = await sendChannelEmbed(client, config.botLogChannelId, embed, "lifecycle (bot-logs)");
    if (sent) return;
    // Bot-logs channel unreachable — fall through to dev-log so the
    // announcement still lands somewhere a human will see it.
  }
  if (config.devLogChannelId) {
    await sendChannelEmbed(client, config.devLogChannelId, embed, "lifecycle (fallback to dev-log)");
    return;
  }
  log.debug("DEVLOG", "No log channel configured — lifecycle announcement skipped.");
}

export async function announceOnline(client: Client): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await sendLifecycleAnnouncement(
    client,
    baseEmbed()
      .setTitle("🟢 Bot Online")
      .setDescription(`${config.botName} v${config.version} is now online and listening for commands.`)
      .addFields(
        { name: "Version", value: `\`${config.version}\``, inline: true },
        { name: "Servers", value: `${client.guilds.cache.size}`, inline: true },
        { name: "Node", value: process.version, inline: true },
        { name: "Started", value: `<t:${now}:F>\n<t:${now}:R>`, inline: false },
      ),
  );
}

export async function announceOffline(client: Client, reason: string, requestedBy: string | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const embed = baseEmbed()
    .setTitle("🔴 Bot Going Offline")
    .setDescription(`${config.botName} is disconnecting now.`)
    .addFields(
      { name: "Reason", value: reason, inline: true },
      { name: "Went Offline", value: `<t:${now}:F>\n<t:${now}:R>`, inline: false },
    );

  if (requestedBy) {
    embed.addFields({ name: "Requested By", value: requestedBy, inline: true });
  }

  await sendLifecycleAnnouncement(client, embed);
}
