import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

const DICE_REGEX = /^(\d{1,2})d(\d{1,4})([+-]\d{1,3})?$/i;
const MAX_DICE = 20;

function rollDice(notation: string) {
  const match = notation.trim().match(DICE_REGEX);
  if (!match) return null;

  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;

  if (count < 1 || count > MAX_DICE || sides < 2) return null;

  const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;

  return { rolls, modifier, total, count, sides };
}

function buildEmbed(notation: string, result: NonNullable<ReturnType<typeof rollDice>>) {
  const modifierText = result.modifier !== 0 ? ` ${result.modifier > 0 ? "+" : ""}${result.modifier}` : "";
  // Natural max rolls get bolded — the dice-roller's version of a crit.
  const rollsDisplay = result.rolls.map((r) => (r === result.sides ? `**${r}**` : `${r}`)).join(", ");

  return baseEmbed()
    .setTitle(`🎲 Rolling ${result.count}d${result.sides}${modifierText}`)
    .addFields(
      { name: "Rolls", value: rollsDisplay, inline: false },
      { name: "Total", value: `**${result.total}**`, inline: false },
    );
}

const INVALID_NOTATION_MESSAGE = (notation: string) =>
  `Invalid dice notation \`${notation}\`. Use something like \`2d6\`, \`1d20+5\`, or \`4d8-2\` (max ${MAX_DICE} dice, 2-9999 sides).`;

const command: Command = {
  category: "utility",
  surface: "both",
  usage: ">roll [notation]",
  description: "Roll dice with standard notation (2d6+3).",
  details:
    "Full dice notation for tabletop and games: `<count>d<sides>` with an optional " +
    "±modifier — `2d6`, `1d20+5`, `4d8-2`. Every roll is shown, natural maximums " +
    "are bolded like crits, and the total is summed. Up to 20 dice, 2–9999 sides. " +
    "No notation? Plain 1d6.",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("roll")
    .setDescription("Roll dice using standard notation (e.g. 2d6, 1d20+5).")
    .addStringOption((opt) =>
      opt.setName("dice").setDescription("Dice notation, e.g. '2d6' or '1d20+5'").setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const notation = interaction.options.getString("dice") ?? "1d6";
    log.info("CMD", `/roll invoked by ${interaction.user.tag} (${interaction.user.id}): ${notation}`);
    const result = rollDice(notation);
    if (!result) {
      // Errors stay ephemeral — they're only useful to the person
      // who typo'd the notation, not to the whole channel.
      await interaction.reply({ embeds: [errorEmbed(INVALID_NOTATION_MESSAGE(notation))], flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ embeds: [buildEmbed(notation, result)] });
  },

  prefixNames: ["roll"],
  async prefixExecute(message: Message, args: string[]) {
    const notation = args[0] ?? "1d6";
    log.info("PREFIX", `>roll invoked by ${message.author.tag} (${message.author.id}): ${notation}`);
    const result = rollDice(notation);
    if (!result) {
      await message.reply({ embeds: [errorEmbed(INVALID_NOTATION_MESSAGE(notation))] });
      return;
    }
    await message.reply({ embeds: [buildEmbed(notation, result)] });
  },
};

export default command;
