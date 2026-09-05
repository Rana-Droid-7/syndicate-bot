import { type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, successEmbed, errorEmbed } from "../../lib/embeds.js";
import { ContextError } from "../../lib/errors.js";
import { afkService } from "../../services/afk.js";
import { formatDuration } from "../../lib/format.js";
import { log } from "../../core/logger.js";

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "afk",
  usage: "afk [reason] · afk off",
  description: "Mark yourself away — or clear it when you're back.",
  details:
    "Sets a per-server AFK status with an optional reason. Anyone mentioning you " +
    "gets a notice with the reason and how long you've been gone (throttled to " +
    "one notice per channel per minute so it can't be weaponized). Clear it with " +
    "`>afk off` — or just send any message and the bot welcomes you back. AFK is " +
    "tracked per-guild and survives restarts.",
  examples: ["afk getting coffee", "afk off"],
  cooldownSeconds: 3,
  prefixNames: ["afk"],

  prefixExecute: async (message: Message, args: string[]) => {
    if (!message.guild) throw new ContextError("AFK only works in a server — it's per-guild.");
    const guildId = message.guild.id;

    const first = (args[0] ?? "").toLowerCase();

    // Explicit off — no more "send any message to clear" requirement.
    // "off"/"clear" is only an intent when it's the WHOLE argument:
    // ">afk off to lunch" is a reason, not a toggle (the old
    // single-token check silently cleared AFK instead of setting
    // that perfectly plausible reason).
    if (args.length === 1 && (first === "off" || first === "clear")) {
      const cleared = afkService.clear(guildId, message.author.id);
      if (!cleared) {
        await message.reply({ embeds: [errorEmbed("You weren't AFK in this server.")] });
        return;
      }
      log.info("AFK", `${message.author.tag} (${message.author.id}) ran >afk off in guild ${guildId}.`);
      await message.reply({
        embeds: [
          successEmbed(`AFK status cleared. You were away for **${formatDuration(cleared.awayMs)}**.`),
        ],
      });
      return;
    }

    // No reason given while already AFK -> toggle off (v0.1.8 behavior
    // that the v0.5.0 rewrite accidentally dropped — restored).
    const rawReason = args.join(" ").trim();
    if (!rawReason && afkService.isAfk(guildId, message.author.id)) {
      const cleared = afkService.clear(guildId, message.author.id);
      if (cleared) {
        log.info("AFK", `${message.author.tag} (${message.author.id}) toggled AFK off in guild ${guildId}.`);
        await message.reply({
          embeds: [successEmbed(`AFK status cleared. You were away for **${formatDuration(cleared.awayMs)}**.`)],
        });
        return;
      }
    }

    const status = afkService.set(guildId, message.author.id, rawReason || "AFK");
    log.info("AFK", `${message.author.tag} (${message.author.id}) set AFK in guild ${guildId}: ${JSON.stringify(status.reason)}`);
    await message.reply({
      embeds: [
        baseEmbed().setDescription(`💤 ${message.author}, I've marked you as AFK: **${status.reason}**`),
      ],
    });
  },
};

export default command;
