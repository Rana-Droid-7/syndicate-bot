import { EmbedBuilder } from "discord.js";
import { config } from "../core/config.js";

export const EMBED_COLORS = {
  brand: 0x5865f2, // Discord blurple
  success: 0x57f287, // Discord green
  error: 0xed4245, // Discord red
  warning: 0xfee75c, // Discord yellow
} as const;

/**
 * Base embed with Syndicate Bot's standard color, timestamp, and a
 * branded footer. Every command should build off this rather than raw
 * EmbedBuilder so the bot has a consistent visual identity. Commands
 * that need their own footer text just call setFooter again — that
 * cleanly overrides this one.
 */
export function baseEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(config.embedColor)
    .setTimestamp()
    .setFooter({ text: `${config.botName} • v${config.version}` });
}

/** Green ✅ embed for successful actions. */
export function successEmbed(description: string): EmbedBuilder {
  return baseEmbed().setColor(EMBED_COLORS.success).setDescription(`✅ ${description}`);
}

/** Red ❌ embed for failures — user-facing errors, never stack traces. */
export function errorEmbed(description: string): EmbedBuilder {
  return baseEmbed().setColor(EMBED_COLORS.error).setDescription(`❌ ${description}`);
}

/** Yellow ⚠️ embed for cautions and confirmations. */
export function warnEmbed(description: string): EmbedBuilder {
  return baseEmbed().setColor(EMBED_COLORS.warning).setDescription(`⚠️ ${description}`);
}
