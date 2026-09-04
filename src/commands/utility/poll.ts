import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { discordTimestamp } from "../../lib/format.js";
import { log } from "../../core/logger.js";

const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 60;
// The question goes into the embed title (256-char hard limit) and
// options into both the description and button labels (80-char label
// limit) — cap them here so no input can ever overflow Discord's
// embed/component validation and turn into a generic dispatcher error.
const MAX_QUESTION_LENGTH = 150;
const MAX_OPTION_LENGTH = 80;
const NUMBER_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const BAR_LENGTH = 12;
const BUTTONS_PER_ROW = 5;

function buildBar(count: number, total: number): string {
  if (total === 0) return "░".repeat(BAR_LENGTH);
  const filled = Math.round((count / total) * BAR_LENGTH);
  return "█".repeat(filled) + "░".repeat(BAR_LENGTH - filled);
}

function buildResultsEmbed(question: string, options: string[], votes: Map<string, number>, ended: boolean, endUnix: number) {
  const counts = options.map((_, i) => [...votes.values()].filter((v) => v === i).length);
  const total = counts.reduce((a, b) => a + b, 0);

  const lines = options.map((opt, i) => {
    const count = counts[i];
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `${NUMBER_EMOJI[i]} **${opt}**\n${buildBar(count, total)} ${count} vote${count === 1 ? "" : "s"} (${pct}%)`;
  });

  return baseEmbed()
    .setTitle(`📊 ${question}`)
    .setDescription(lines.join("\n\n"))
    .setFooter({
      text: ended
        ? `Poll closed • ${total} total vote(s)`
        : `Vote below • closes ${discordTimestamp(endUnix, "R")} • ${total} vote(s) so far`,
    });
}

function chunkRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
  }
  return rows;
}

const command: Command = {
  category: "utility",
  surface: "slash-only",
  usage: "/poll <question> <option1> <option2> [options...] [minutes]",
  data: new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Create a quick poll with button voting.")
    .addStringOption((o) => o.setName("question").setDescription("The poll question").setRequired(true).setMaxLength(MAX_QUESTION_LENGTH))
    .addStringOption((o) => o.setName("option1").setDescription("First option").setRequired(true).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option2").setDescription("Second option").setRequired(true).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option3").setDescription("Third option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option4").setDescription("Fourth option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option5").setDescription("Fifth option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option6").setDescription("Sixth option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option7").setDescription("Seventh option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option8").setDescription("Eighth option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option9").setDescription("Ninth option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addStringOption((o) => o.setName("option10").setDescription("Tenth option").setRequired(false).setMaxLength(MAX_OPTION_LENGTH))
    .addIntegerOption((o) =>
      o
        .setName("minutes")
        .setDescription(`How long the poll runs (default 5, max ${MAX_POLL_MINUTES})`)
        .setMinValue(MIN_POLL_MINUTES)
        .setMaxValue(MAX_POLL_MINUTES)
        .setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const question = interaction.options.getString("question", true);
    const options = Array.from({ length: 10 }, (_, n) => interaction.options.getString(`option${n + 1}`)).filter(
      (o): o is string => !!o,
    );
    const minutes = interaction.options.getInteger("minutes") ?? 5;
    const durationMs = minutes * 60_000;
    const endUnix = Math.floor((Date.now() + durationMs) / 1000);

    log.info("CMD", `/poll invoked by ${interaction.user.tag} (${interaction.user.id}): "${question}" with ${options.length} options for ${minutes}m`);

    const votes = new Map<string, number>(); // userId -> option index

    const buttons = options.map((opt, i) =>
      new ButtonBuilder()
        .setCustomId(`poll-${i}`)
        .setLabel(opt.slice(0, 80))
        .setEmoji(NUMBER_EMOJI[i])
        .setStyle(ButtonStyle.Primary),
    );
    const rows = chunkRows(buttons);

    const response = await interaction.reply({
      embeds: [buildResultsEmbed(question, options, votes, false, endUnix)],
      components: rows,
      withResponse: true,
    });

    const collector = response.resource!.message!.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: durationMs,
    });

    // Votes are applied to the `votes` Map synchronously and always
    // correct in memory. The DISPLAYED message, though, is only as
    // correct as the last network request that happened to land —
    // if two people vote in quick succession, their two update()
    // calls race, and a slower one finishing after a faster one can
    // briefly make the poll's vote count APPEAR to go backward.
    // Chaining every update through a single promise serializes them
    // in submission order and guarantees each one renders whatever
    // `votes` looks like at the moment it actually runs, so the
    // display can never regress.
    let updateChain: Promise<void> = Promise.resolve();

    collector.on("collect", async (i: ButtonInteraction) => {
      const optionIndex = Number(i.customId.split("-")[1]);
      votes.set(i.user.id, optionIndex);
      log.info("CMD", `Poll vote: ${i.user.tag} (${i.user.id}) voted for option ${optionIndex} ("${options[optionIndex]}") on "${question}"`);

      updateChain = updateChain
        .then(async () => {
          await i.update({ embeds: [buildResultsEmbed(question, options, votes, false, endUnix)] });
        })
        .catch((error) => log.error("CMD", "Failed to update poll message after a vote", error));
    });

    collector.on("end", () => {
      log.info("CMD", `Poll "${question}" closed with ${votes.size} total vote(s).`);
      const disabledRows = rows.map((row) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          row.components.map((b) => ButtonBuilder.from(b).setDisabled(true)),
        ),
      );
      // Chain through the SAME serialization as the vote updates —
      // otherwise a final editReply racing the last in-flight vote
      // update could land first and leave the poll showing the live
      // "Vote below" footer forever, with the vote's update wiping
      // the closed state afterward.
      updateChain = updateChain
        .then(async () => {
          await interaction.editReply({
            embeds: [buildResultsEmbed(question, options, votes, true, endUnix)],
            components: disabledRows,
          });
        })
        .catch((error) => log.error("CMD", "Failed to finalize poll message on close", error));
    });
  },

  // Surface "slash-only" (declared in metadata above): reliable
  // multi-option input needs structured fields, which the prefix
  // can't offer as cleanly.
};

export default command;
