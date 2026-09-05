import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed } from "../../lib/embeds.js";
import { safeEvaluate } from "../../lib/safeMath.js";
import { escapeCodeBlock } from "../../lib/validation.js";
import { log } from "../../core/logger.js";

async function buildEmbed(expression: string) {
  const result = await safeEvaluate(expression);

  if (!result.ok) {
    return baseEmbed().setDescription(result.error ?? "Couldn't evaluate that expression.");
  }

  return baseEmbed()
    .setTitle("🧮 Calculator")
    .addFields(
      { name: "Expression", value: `\`${escapeCodeBlock(expression)}\``, inline: false },
      { name: "Result", value: `\`${escapeCodeBlock(result.resultText ?? "")}\``, inline: false },
    );
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "calculate",
  usage: "calc <expression>",
  description: "Evaluate math — from basic sums to sqrt, trig, and powers.",
  details:
    "A real calculator: arithmetic, parentheses, powers (`2^10`), `sqrt()`, `log()`, " +
    "trig, constants. Runs in an isolated worker thread with a 3-second kill timer " +
    "and hard memory limits — nothing you type can hang or crash the bot. Results " +
    "over 500 characters are politely declined. 200 characters per expression.",
  cooldownSeconds: 3,

  prefixNames: ["calculate", "calc", "math"],
  async prefixExecute(message: Message, args: string[]) {
    if (args.length === 0) {
      await message.reply(`Usage: \`${config.prefix}calc <expression>\` — e.g. \`${config.prefix}calc (3 + 4) * 2\``);
      return;
    }
    const expression = args.join(" ").slice(0, 200);
    log.info("PREFIX", `>calc invoked by ${message.author.tag} (${message.author.id}): ${JSON.stringify(expression)}`);
    await message.reply({ embeds: [await buildEmbed(expression)] });
  },
};

export default command;
