import { SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

const command: Command = {
  category: "utility",
  surface: "both",
  usage: ">ping",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check Syndicate Bot's latency."),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("CMD", `/ping invoked by ${interaction.user.tag} (${interaction.user.id})`);
    const sent = await interaction.reply({ content: "🏓 Pinging...", withResponse: true });
    const latency =
      (sent.resource?.message?.createdTimestamp ?? Date.now()) - interaction.createdTimestamp;

    await interaction.editReply({
      content: null,
      embeds: [
        baseEmbed()
          .setTitle("🏓 Pong!")
          .addFields(
            { name: "Roundtrip Latency", value: `\`${latency}ms\``, inline: true },
            { name: "WebSocket Ping", value: `\`${interaction.client.ws.ping}ms\``, inline: true },
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
            { name: "WebSocket Ping", value: `\`${message.client.ws.ping}ms\``, inline: true },
          ),
      ],
    });
  },
};

export default command;
