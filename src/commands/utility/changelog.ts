import { SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { config } from "../../core/config.js";
import { log } from "../../core/logger.js";

interface ReleaseNotes {
  version: string;
  date: string;
  highlights: string[];
}

// Keep in sync with CHANGELOG.md at the project root. Only the most
// recent few releases are listed here — Discord embeds have hard
// length limits and nobody scrolls a changelog in-chat anyway.
const RELEASES: ReleaseNotes[] = [
  {
    version: "0.5.0-beta",
    date: "2026-09-04",
    highlights: [
      "**SQL database**: AFK, reminders, warnings, suggestions, and jokes are now persistent — they survive restarts, crashes, and redeploys",
      "**Reminders are durable**: every reminder is stored and restored on startup; nothing is lost to a restart ever again",
      "**New Coolsies category**: dice, coinflip, 8ball, choose, random, rate — fun commands with personality",
      "**Joke system**: `>joke say` for everyone; developers manage the collection (add/list/remove/edit/enable/disable)",
      "**`>` is the primary interface**: public commands live on the prefix; slash is reserved for moderation/admin/developer tools",
      "**Per-user cooldowns** on fun commands so they can't be spammed",
      "**`>afk off`** — explicit AFK clear, no more 'send any message'",
      "**Quoted-argument parsing** for prefix commands (`>remindme \"in 2 hours\" stretch`)",
      "**Error taxonomy**: every failure renders a clean, styled message with correct usage — never a stack trace",
      "**Load-time command validation**: duplicate names or broken metadata refuse to boot the bot, loudly",
    ],
  },
  {
    version: "0.2.0-beta",
    date: "2026-09-04",
    highlights: [
      "**Help system redesigned**: branded command center, browseable categories, and `/help <command>` detail pages with exact usage",
      "**Typo suggestions**: `>rolll` now gets told it probably meant **/roll**, with correct usage shown",
      "**Strict slash-only**: mod/admin/dev/poll commands explain themselves via prefix instead of silence",
      "**Private verbose-log mirror**: live operational feed into your own private channel (BOT_LOG_CHANNEL_ID)",
      "**Codebase reorganized**: core/ foundation split from lib/ helpers",
      "Poll close-race fixed; unknown slash commands get styled errors",
    ],
  },
  {
    version: "0.1.8-beta",
    date: "2026-09-04",
    highlights: [
      "Right-click context commands: **User Info** and **Avatar** from the Apps menu on any user",
      "/poll now supports up to 10 options, custom durations (1–60 min), and a closing countdown",
      "/userinfo shows profile banners and badge emojis",
      "/serverinfo shows the server banner, description, vanity invite, and a boost progress bar",
      "**/boot redesigned**: one command DMs you a private Reboot/Shutdown/Cancel button panel",
      "Dev-log channel now gets 🟢 online / 🔴 offline announcements on every startup and shutdown",
      "Full-audit revamp: /warn add now runs the same hierarchy check as kick/ban/timeout",
      "AFK is per-guild with a mention-notice cooldown",
    ],
  },
];

// Truncates a release's highlight list to fit a single embed field
// value (1024 chars), cutting on whole bullet lines — never mid-word
// or mid-emoji — and noting how many entries were dropped.
function formatHighlights(highlights: string[], limit = 1024): string {
  const bullets = highlights.map((h) => `• ${h}`);
  const note = (dropped: number) => `\n_…and ${dropped} more in CHANGELOG.md._`;

  // Worst case: everything fits, plus no note needed.
  if (bullets.join("\n").length <= limit) return bullets.join("\n");

  // Find the largest prefix of whole bullets that fits, leaving room
  // for the "and N more" note.
  let used = 0;
  let kept = 0;
  for (const bullet of bullets) {
    const noteLen = note(bullets.length - kept).length;
    if (used + bullet.length + 1 > limit - noteLen) break;
    used += bullet.length + 1;
    kept++;
  }

  if (kept === 0) {
    // A single bullet alone exceeds the field limit (shouldn't
    // happen with sane highlights) — hard-slice it at the char level.
    return `${bullets[0].slice(0, limit - 1)}…`;
  }

  return bullets.slice(0, kept).join("\n") + note(bullets.length - kept);
}

function buildChangelogEmbed() {
  const embed = baseEmbed()
    .setTitle("📜 Changelog")
    .setDescription(`The latest releases of ${config.botName}.`);

  for (const release of RELEASES) {
    const isCurrent = release.version === config.version;
    embed.addFields({
      name: `${isCurrent ? "🆕 " : ""}v${release.version} — ${release.date}`,
      value: formatHighlights(release.highlights),
      inline: false,
    });
  }

  embed.setFooter({ text: "Detailed notes live in CHANGELOG.md in the repository." });
  return embed;
}

const command: Command = {
  category: "utility",
  surface: "both",
  usage: ">changelog",
  cooldownSeconds: 5,
  data: new SlashCommandBuilder()
    .setName("changelog")
    .setDescription("See what's new in the latest Syndicate Bot releases."),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("CMD", `/changelog invoked by ${interaction.user.tag} (${interaction.user.id})`);
    await interaction.reply({ embeds: [buildChangelogEmbed()] });
  },

  prefixNames: ["changelog", "changes"],
  async prefixExecute(message: Message) {
    log.info("PREFIX", `>changelog invoked by ${message.author.tag} (${message.author.id})`);
    await message.reply({ embeds: [buildChangelogEmbed()] });
  },
};

export default command;
