import { SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

const FACES = ["Heads", "Tails"] as const;

const command: Command = {
  category: "coolsies",
  surface: "both",
  usage: ">coinflip",
  examples: [">coinflip"],
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Flip a coin."),

  async execute(interaction: ChatInputCommandInteraction) {
    const result = FACES[Math.floor(Math.random() * FACES.length)];
    log.debug("COOLSIES", `Coinflip: ${result}`);
    await interaction.reply({
      embeds: [baseEmbed().setTitle("🪙 Flipping...").setDescription(`🪙 It's **${result}**!`)],
    });
  },

  prefixExecute: async (message: Message) => {
    const result = FACES[Math.floor(Math.random() * FACES.length)];
    log.debug("COOLSIES", `Coinflip: ${result}`);
    await message.reply({
      embeds: [baseEmbed().setTitle("🪙 Flipping...").setDescription(`🪙 It's **${result}**!`)],
    });
  },
};

export default command;
