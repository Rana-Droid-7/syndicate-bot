import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

function wsPingText(ping: number): string {
  // -1 = no heartbeat yet (just started / reconnecting) — show that
  // honestly instead of a bogus "-1ms".
  return ping >= 0 ? `\`${ping}ms\`` : "connecting…";
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "ping",
  usage: "ping",
  description: "Check the bot's latency.",
  details:
    "Measures the real round-trip (your message in, the reply out) plus the " +
    "gateway heartbeat. If the bot feels sluggish, this tells you whether it's " +
    "the connection or something else.",
  cooldownSeconds: 3,

  prefixNames: ["ping", "latency"],
  async prefixExecute(message: Message) {
    log.info("PREFIX", `${config.prefix}ping invoked by ${message.author.tag} (${message.author.id})`);
    const sent = await message.reply("🏓 Pinging...");
    const latency = sent.createdTimestamp - message.createdTimestamp;
    await sent.edit({
      content: null,
      embeds: [
        baseEmbed()
          .setTitle("🏓 Pong!")
          .addFields(
            { name: "Roundtrip Latency", value: `\`${latency}ms\``, inline: true },
            { name: "WebSocket Ping", value: wsPingText(message.client.ws.ping), inline: true },
          ),
      ],
    });
  },
};

export default command;
