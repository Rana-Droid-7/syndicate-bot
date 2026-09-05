import { SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

function wsPingText(ping: number): string {
  // -1 = no heartbeat yet (just started / reconnecting) — show that
  // honestly instead of a bogus "-1ms".
  return ping >= 0 ? `\`${ping}ms\`` : "connecting…";
}

const command: Command = {
  category: "utility",
  surface: "both",
  usage: ">ping",
  description: "Check the bot's latency.",
  details:
    "Measures the real round-trip (your message in, the reply out) plus the " +
    "gateway heartbeat. If the bot feels sluggish, this tells you whether it's " +
    "the connection or something else.",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check Syndicate Bot's latency."),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("CMD", `/ping invoked by ${interaction.user.tag} (${interaction.user.id})`);
    const sent = await interaction.reply({ content: "🏓 Pinging...", withResponse: true });
    const sentAt = sent.resource?.message?.createdTimestamp;
    // If the ack payload carried no timestamp, "now" is the only
    // remaining reference — but subtracting the interaction's own
    // creation time would report ~0ms for an arbitrarily slow ack,
    // so only measure when both ends are real.
    const latency = sentAt !== undefined ? sentAt - interaction.createdTimestamp : null;

    await interaction.editReply({
      content: null,
      embeds: [
        baseEmbed()
          .setTitle("🏓 Pong!")
          .addFields(
            { name: "Roundtrip Latency", value: latency !== null ? `\`${latency}ms\`` : "measuring…", inline: true },
            { name: "WebSocket Ping", value: wsPingText(interaction.client.ws.ping), inline: true },
          ),
      ],
    });
  },

  prefixNames: ["ping", "latency"],
  async prefixExecute(message: Message) {
    log.info("PREFIX", `>ping invoked by ${message.author.tag} (${message.author.id})`);
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
