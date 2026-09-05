import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed } from "../../lib/embeds.js";
import { log } from "../../core/logger.js";

const CHOICES = ["rock", "paper", "scissors"] as const;
type Choice = (typeof CHOICES)[number];

const EMOJI: Record<Choice, string> = { rock: "🪨", paper: "📄", scissors: "✂️" };
const BEATS: Record<Choice, Choice> = { rock: "scissors", paper: "rock", scissors: "paper" };

function outcome(player: Choice, bot: Choice): "win" | "lose" | "draw" {
  if (player === bot) return "draw";
  return BEATS[player] === bot ? "win" : "lose";
}

const command: Command = {
  category: "coolsies",
  surface: "both",
  usage: ">rps [rock|paper|scissors]",
  examples: [">rps rock", ">rps"],
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("rps")
    .setDescription("Rock Paper Scissors — instant, or with buttons."),

  async execute(interaction: ChatInputCommandInteraction) {
    // Slash surface: button duel against the bot. Only the invoker's
    // clicks count — anyone else gets a private "not yours" note.
    const embed = baseEmbed()
      .setTitle("✊ 🖐 ✌️ Rock Paper Scissors")
      .setDescription(`${interaction.user}, pick your weapon — 30 seconds, one round.`);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("rps-rock").setLabel("Rock").setEmoji("🪨").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rps-paper").setLabel("Paper").setEmoji("📄").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("rps-scissors").setLabel("Scissors").setEmoji("✂️").setStyle(ButtonStyle.Primary),
    );

    const response = await interaction.reply({
      embeds: [embed],
      components: [row],
      withResponse: true,
    });
    const message = response.resource!.message!;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 30_000,
      max: 1,
      // Non-invoker clicks are rejected in the FILTER, not the
      // collect handler — with max:1, a stranger's click would
      // otherwise consume the invoker's only slot and lock the game.
      // Filter rejections never count toward max.
      filter: async (i) => {
        if (i.user.id !== interaction.user.id) {
          await i
            .reply({ content: "This game isn't yours — run `/rps` yourself!", flags: MessageFlags.Ephemeral })
            .catch(() => null);
          return false;
        }
        return true;
      },
    });

    collector.on("collect", async (i: ButtonInteraction) => {
      const player = i.customId.replace("rps-", "") as Choice;
      const bot = CHOICES[Math.floor(Math.random() * CHOICES.length)];
      const result = outcome(player, bot);

      const verdict =
        result === "win" ? "🎉 **You win!**" : result === "lose" ? "😅 **I win!**" : "🤝 **Draw!**";

      const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
        row.components.map((b) => ButtonBuilder.from(b).setDisabled(true)),
      );

      await i
        .update({
          embeds: [
            baseEmbed()
              .setTitle("✊ 🖐 ✌️ Rock Paper Scissors")
              .setDescription(
                `You: ${EMOJI[player]} **${player}**\nMe: ${EMOJI[bot]} **${bot}**\n\n${verdict}`,
              ),
          ],
          components: [disabled],
        })
        .catch((err) => log.error("COOLSIES", "Failed to finalize rps round", err));
    });

    collector.on("end", async (_c, reason) => {
      if (reason !== "time") return;
      const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
        row.components.map((b) => ButtonBuilder.from(b).setDisabled(true)),
      );
      await message
        .edit({
          embeds: [embed.setDescription("⌛ Round expired — run `/rps` for a rematch.")],
          components: [disabled],
        })
        .catch(() => null);
    });
  },

  prefixNames: ["rps", "rockpaperscissors"],
  async prefixExecute(message: Message, args: string[]) {
    // Prefix surface: instant round, argument picks the weapon.
    const raw = (args[0] ?? "").toLowerCase() as Choice;
    if (raw && !CHOICES.includes(raw)) {
      await message.reply({
        embeds: [errorEmbed(`\`${args[0]}\` isn't rock, paper, or scissors — try \`>rps rock\`.`)],
      });
      return;
    }

    const player: Choice = raw || CHOICES[Math.floor(Math.random() * CHOICES.length)];
    const bot = CHOICES[Math.floor(Math.random() * CHOICES.length)];
    const result = outcome(player, bot);
    const verdict =
      result === "win" ? "🎉 **You win!**" : result === "lose" ? "😅 **I win!**" : "🤝 **Draw!**";

    log.debug("COOLSIES", `rps: ${message.author.id} picked ${player}, bot rolled ${bot} -> ${result}`);
    await message.reply({
      embeds: [
        baseEmbed()
          .setTitle("✊ 🖐 ✌️ Rock Paper Scissors")
          .setDescription(
            `You: ${EMOJI[player]} **${player}**\nMe: ${EMOJI[bot]} **${bot}**\n\n${verdict}\n` +
              `_Buttons too: try /rps for the clickable version._`,
          ),
      ],
    });
  },
};

export default command;
