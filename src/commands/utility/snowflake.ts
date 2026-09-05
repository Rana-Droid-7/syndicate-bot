import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed } from "../../lib/embeds.js";
import { discordTimestamp } from "../../lib/format.js";
import { log } from "../../core/logger.js";

const DISCORD_EPOCH = 1420070400000n; // 2015-01-01T00:00:00.000Z

function decodeSnowflake(id: string) {
  if (!/^\d{15,20}$/.test(id)) return null;

  try {
    const bigId = BigInt(id);
    const ms = (bigId >> 22n) + DISCORD_EPOCH;
    return Number(ms);
  } catch {
    return null;
  }
}

function buildEmbed(id: string) {
  const ms = decodeSnowflake(id);

  if (ms === null) {
    return baseEmbed().setDescription(
      `\`${id}\` doesn't look like a valid Discord ID/snowflake (should be 15-20 digits).`,
    );
  }

  const unixSeconds = Math.floor(ms / 1000);

  return baseEmbed()
    .setTitle("🔍 Snowflake Decoded")
    .addFields(
      { name: "ID", value: `\`${id}\``, inline: false },
      {
        name: "Created",
        value: `${discordTimestamp(unixSeconds, "F")}\n${discordTimestamp(unixSeconds, "R")}`,
        inline: false,
      },
    )
    .setFooter({ text: "Works for any Discord ID: user, server, channel, message, role..." });
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  usage: "snowflake <id>",
  description: "Decode any Discord ID to its creation date.",
  details:
    "Every Discord ID (user, server, channel, message, role) encodes the exact " +
    "moment it was created. Paste one in and the bot decodes it to a live " +
    "timestamp — handy for spotting alt accounts and checking \"how old is this " +
    "server, really\".",
  cooldownSeconds: 3,

  prefixNames: ["snowflake", "decode"],
  async prefixExecute(message: Message, args: string[]) {
    const id = args[0]?.trim();
    log.info("PREFIX", `>snowflake invoked by ${message.author.tag} (${message.author.id}): ${id}`);
    if (!id) {
      await message.reply(`Usage: \`${config.prefix}snowflake <id>\``);
      return;
    }
    await message.reply({ embeds: [buildEmbed(id)] });
  },
};

export default command;
