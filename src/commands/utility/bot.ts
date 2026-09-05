import { version as djsVersion, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { formatDuration, formatBytes } from "../../lib/format.js";
import { config } from "../../core/config.js";
import { buildInviteButtonRow } from "../../lib/help.js";
import type { SyndicateClient } from "../../core/client.js";
import { log } from "../../core/logger.js";

function buildBotInfoEmbed(client: SyndicateClient) {
  const uptime = client.uptime ?? Date.now() - client.startTime;
  const memory = process.memoryUsage().heapUsed;
  const guildCount = client.guilds.cache.size;
  const userCount = client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);

  const developerLine = config.ownerId ? `<@${config.ownerId}>` : config.author;

  return baseEmbed()
    .setTitle(`${config.botName} — Info`)
    .setThumbnail(client.user?.displayAvatarURL() ?? null)
    .setDescription(`A modern utility & moderation bot for Discord by **${config.author}**.`)
    .addFields(
      { name: "Version", value: `\`${config.version}\``, inline: true },
      { name: "Uptime", value: formatDuration(uptime), inline: true },
      { name: "Memory Usage", value: formatBytes(memory), inline: true },
      { name: "Primary Language", value: "TypeScript (Node.js)", inline: true },
      { name: "Library", value: `discord.js v${djsVersion}`, inline: true },
      { name: "Node.js", value: process.version, inline: true },
      { name: "Database", value: "SQLite (persistent)", inline: true },
      { name: "Servers", value: `${guildCount}`, inline: true },
      { name: "Members (combined)", value: `${userCount}`, inline: true },
      { name: "Developer", value: developerLine, inline: false },
    )
    .setFooter({ text: `${config.botName} ${config.version} • run ${config.prefix}changelog to see what's new` });
}

function buildBotInfoPayload(client: SyndicateClient) {
  return { embeds: [buildBotInfoEmbed(client)], components: [buildInviteButtonRow()] };
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "bot",
  usage: "bot",
  description: "Everything about the bot — version, uptime, stats, invite.",
  details:
    "The bot's ID card: current version, uptime, memory usage, server and member " +
    "counts, the library stack it runs on, and who built it. Includes an invite " +
    "button if you want it in your own server.",
  cooldownSeconds: 5,

  prefixNames: ["bot", "botinfo", "about"],
  async prefixExecute(message: Message) {
    const client = message.client as SyndicateClient;
    log.info("PREFIX", `>bot invoked by ${message.author.tag} (${message.author.id})`);
    await message.reply(buildBotInfoPayload(client));
  },
};

export default command;
