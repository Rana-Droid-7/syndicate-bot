import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

const FACES = ["Heads", "Tails"] as const;

const command: Command = {
  category: "coolsies",
  surface: "prefix-only",
  name: "coinflip",
  usage: "coinflip",
  description: "Flip a coin — heads or tails.",
  details: "The classic 50/50. One flip, one answer, zero ceremony. Settle it the old-fashioned way.",
  examples: ["coinflip"],
  cooldownSeconds: 3,

  prefixExecute: async (message: Message) => {
    const result = FACES[Math.floor(Math.random() * FACES.length)];
    log.debug("COOLSIES", `Coinflip: ${result}`);
    await message.reply({
      embeds: [baseEmbed().setTitle("🪙 Flipping...").setDescription(`🪙 It's **${result}**!`)],
    });
  },
};

export default command;
