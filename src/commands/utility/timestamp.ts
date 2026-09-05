import { type Message } from "discord.js";
import * as chrono from "chrono-node";
import type { Command } from "../../types/command.js";
import { config } from "../../core/config.js";
import { baseEmbed } from "../../lib/embeds.js";
import { discordTimestamp, type TimestampStyle } from "../../lib/format.js";
import { log } from "../../core/logger.js";

function buildResult(input: string, style: TimestampStyle) {
  const parsedDate = chrono.parseDate(input, new Date(), { forwardDate: true });

  if (!parsedDate) {
    return null;
  }

  const unixSeconds = Math.floor(parsedDate.getTime() / 1000);
  const tag = discordTimestamp(unixSeconds, style);

  return baseEmbed()
    .setTitle("🕒 Discord Timestamp Generator")
    .setDescription(
      `**Preview** (renders in *your* local time — everyone who sees it will see their own):\n${tag}\n\n` +
        `**Copy this into any message:**\n\`\`\`${tag}\`\`\``,
    )
    .addFields({ name: "Interpreted Time", value: parsedDate.toUTCString(), inline: false })
    .setFooter({ text: "Powered by natural language date parsing — try things like 'tomorrow 5pm' or 'in 2 hours'." });
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "timestamp",
  usage: "timestamp <time> [style]",
  description: "Turn plain-words time into a Discord timestamp tag.",
  details:
    "Describe a time in plain words — \"tomorrow 5pm\", \"in 3 hours\", \"dec 25 " +
    "2026 9am\" — and the bot returns a Discord timestamp tag you can paste into " +
    "any message. Everyone who sees it views it in their OWN local time zone, so " +
    "event planning stops being a time-zone math headache. Pick a display style " +
    "(t/T/d/D/f/F/R) or take the default relative one.",
  cooldownSeconds: 3,

  prefixNames: ["timestamp", "ts"],
  async prefixExecute(message: Message, args: string[]) {
    if (args.length === 0) {
      await message.reply(`Usage: \`${config.prefix}timestamp <time> [style]\` — e.g. \`${config.prefix}ts tomorrow 5pm\` or \`${config.prefix}ts dec 25 D\` (styles: t T d D f F R)`);
      return;
    }

    // Optional trailing style argument: a lone style letter after the time.
    const STYLES = new Set(["t", "T", "d", "D", "f", "F", "R"]);
    let style: TimestampStyle = "R";
    const timeArgs = [...args];
    const last = timeArgs[timeArgs.length - 1];
    if (timeArgs.length >= 2 && last.length === 1 && STYLES.has(last)) {
      style = last as TimestampStyle;
      timeArgs.pop();
    }

    const input = timeArgs.join(" ");
    log.info("PREFIX", `>timestamp invoked by ${message.author.tag} (${message.author.id}): ${JSON.stringify(input)} style=${style}`);
    const embed = buildResult(input, style);

    if (!embed) {
      await message.reply(`Couldn't understand \`${input}\` as a time. Try something like \`tomorrow 5pm\`.`);
      return;
    }

    await message.reply({ embeds: [embed] });
  },
};

export default command;
