import { type Message, type Guild } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed } from "../../lib/embeds.js";
import { discordTimestamp } from "../../lib/format.js";
import { log } from "../../core/logger.js";

const VERIFICATION_LABELS: Record<number, string> = {
  0: "None",
  1: "Low",
  2: "Medium",
  3: "High",
  4: "Very High",
};

// Cumulative boost counts needed to reach each tier.
const BOOST_TIER_THRESHOLDS = [0, 2, 7, 14];

function buildBoostProgress(count: number, tier: number): string {
  const next = BOOST_TIER_THRESHOLDS[tier + 1];
  if (next === undefined) return `Level 3 — max tier reached 🎉`;

  const prev = BOOST_TIER_THRESHOLDS[tier];
  const span = next - prev;
  const progress = Math.max(0, Math.min(span, count - prev));
  const filled = Math.round((progress / span) * 12);
  const bar = "█".repeat(filled) + "░".repeat(12 - filled);
  return `${bar} ${count}/${next} boosts to Level ${tier + 1}`;
}

async function buildServerInfoEmbed(guild: Guild) {
  const owner = await guild.fetchOwner().catch(() => null);
  const createdUnix = Math.floor(guild.createdTimestamp / 1000);
  const channelCount = guild.channels.cache.size;
  const roleCount = guild.roles.cache.size;
  const boostCount = guild.premiumSubscriptionCount ?? 0;

  const embed = baseEmbed()
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL({ size: 512 }))
    .setColor(0x5865f2);

  if (guild.description) embed.setDescription(guild.description);

  const bannerUrl = guild.bannerURL({ size: 1024 });
  if (bannerUrl) embed.setImage(bannerUrl);

  embed.addFields(
    { name: "Server ID", value: `\`${guild.id}\``, inline: true },
    { name: "Owner", value: owner ? `${owner.user.tag}` : "Unknown", inline: true },
    { name: "Members", value: `${guild.memberCount}`, inline: true },
    {
      name: "Created",
      value: `${discordTimestamp(createdUnix, "F")}\n${discordTimestamp(createdUnix, "R")}`,
      inline: true,
    },
    { name: "Channels", value: `${channelCount}`, inline: true },
    { name: "Roles", value: `${roleCount}`, inline: true },
    { name: "Boost Level", value: `Level ${guild.premiumTier}`, inline: true },
    { name: "Boosts", value: `${boostCount}`, inline: true },
    {
      name: "Verification Level",
      value: VERIFICATION_LABELS[guild.verificationLevel] ?? "Unknown",
      inline: true,
    },
    { name: "Boost Progress", value: buildBoostProgress(boostCount, guild.premiumTier), inline: false },
  );

  if (guild.vanityURLCode) {
    embed.addFields({ name: "Vanity Invite", value: `\`discord.gg/${guild.vanityURLCode}\``, inline: false });
  }

  embed.setFooter({ text: "Timestamps shown adjust automatically to your local timezone." });
  return embed;
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "serverinfo",
  usage: "serverinfo",
  description: "A snapshot of this server — members, boosts, channels, and more.",
  details:
    "The server's ID card: creation date, owner, member count, channel and role " +
    "counts, boost level with a progress bar to the next tier, verification " +
    "level, vanity invite, and the banner if it has one.",
  cooldownSeconds: 3,

  prefixNames: ["serverinfo", "guildinfo", "si"],
  async prefixExecute(message: Message) {
    log.info("PREFIX", `${config.prefix}serverinfo invoked by ${message.author.tag} (${message.author.id})`);
    if (!message.guild) return;
    await message.reply({ embeds: [await buildServerInfoEmbed(message.guild)] });
  },
};

export default command;
