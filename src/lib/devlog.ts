import type { Client, EmbedBuilder } from "discord.js";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";
import { baseEmbed } from "./embeds.js";

/**
 * Posts an embed to a channel by ID, with the same never-throw
 * guarantees as sendDevLog.
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
 * Lifecycle announcements (online/offline) go STRICTLY to the dev-log
 * channel — never to bot-logs. The two channels have a strict contract:
 *
 *   DEV_LOG_CHANNEL_ID  → lifecycle announcements (online/offline) +
 *                         attention-worthy error embeds. Nothing else.
 *   BOT_LOG_CHANNEL_ID  → the raw operational mirror (command
 *                         dispatches, permission decisions, timers,
 *                         AFK changes — batched text lines). Nothing
 *                         else.
 *
 * Mixing them would put embed announcements inside the raw code-block
 * feed (unreadable) and lifecycle noise inside the error channel.
 * If dev-log isn't configured, the announcement is dropped with a
 * console log — it must NOT fall back into bot-logs, ever.
 *
 * Posted on every startup/shutdown path (boot ready, SIGINT/
 * SIGTERM, crash, and /boot panel actions).
 */
async function sendLifecycleAnnouncement(client: Client, embed: EmbedBuilder): Promise<void> {
  if (config.devLogChannelId) {
    await sendChannelEmbed(client, config.devLogChannelId, embed, "lifecycle (dev-log)");
    return;
  }
  log.info("DEVLOG", "DEV_LOG_CHANNEL_ID not configured — lifecycle announcement skipped (never sent to bot-logs).");
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
