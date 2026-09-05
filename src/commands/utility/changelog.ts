import { type Message } from "discord.js";
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
    version: "0.6.0-beta",
    date: "2026-09-05",
    highlights: [
      "**Local dashboard** — the bot now hosts a browser console at localhost for its operator",
      "Manage **jokes** and **8-ball responses** (add/disable/enable/remove), **review suggestions** (approve/reject), watch live stats",
      "**Reboot / shutdown** from the browser — identical semantics to the /boot panel",
      "**Hardened by design**: localhost-only binding, PBKDF2-hashed password (never plaintext), rate-limited login, CSRF-protected sessions",
      "Every dashboard action runs through the same service layer the Discord commands use",
      "29-check security harness attacking the real server — wired into npm run verify",
    ],
  },
  {
    version: "0.5.4-beta",
    date: "2026-09-05",
    highlights: [
      "**One prefix, one rule**: public commands live on the prefix from your `.env` (default `>`); slash is exclusively for moderation, admin, and developer tools",
      "**Change the prefix, everything follows**: set `PREFIX=!` and every menu, usage line, and suggestion flips instantly — nothing is hardcoded",
      "**Prefix is validated at boot**: must be exactly one character, no whitespace, not `/` — or the bot refuses to start with a clear reason",
      "**`poll` is prefix-native** — `poll \"question?\" \"opt1\" \"opt2\" [minutes]` with live bar-chart buttons",
      "**`rps` button duel on the prefix** — plain `rps` opens the clickable duel",
      "Right-click context commands retired; `both` surface removed from the type system",
    ],
  },
  {
    version: "0.5.3-beta",
    date: "2026-09-05",
    highlights: [
      "**Help, rebuilt**: every command now has a proper description + a full `>help <command>` guide — what it does, how it behaves, tips",
      "**Category pages redesigned** — every command listed with its description and usage, scannable at a glance",
      "**Smart `>help`**: typos get a \"did you mean...?\" suggestion before anything else",
      "**8-ball is a full suite now** — `8ball ask/add/list/remove/edit/enable/disable`, exactly like the joke suite",
      "**Preloaded**: 19 classic 8-ball responses + 10 starter jokes ship in the database — no setup needed",
      "Every detail page shows aliases, examples, and cooldowns",
    ],
  },
  {
    version: "0.5.2-beta",
    date: "2026-09-05",
    highlights: [
      "**Security hardening**: every log surface censors token-shaped secrets; error embeds show clean reasons, never internals",
      "**Moderation re-checks EVERYTHING after confirm** — an invoker demoted or bot role moved during the dialog no longer slips through",
      "**`/calculate` memory bombs dead** — the math worker runs with hard heap limits",
      "**New game: `>rps`** — rock-paper-scissors, instant on prefix, clickable button duel on slash (only your clicks count)",
      "One shared error mapper for both dispatchers — database failures now reach the developer log on every surface",
      "Gateway hiccups can't crash the bot anymore",
      "CI on GitHub and GitLab, a `npm run verify` one-shot, LICENSE, issue templates — the full repo treatment",
    ],
  },
  {
    version: "0.5.1-beta",
    date: "2026-09-05",
    highlights: [
      "**Poll fix**: polls running over 15 minutes now close properly (interaction tokens expire — the final edit goes through the bot token instead)",
      "**Crash fix**: mention-heavy `>suggest`/`>joke` input no longer trips the database limit (sanitize-then-truncate everywhere)",
      "**Reminders can't double-ping**: timer and safety-sweep deliveries are deduped per reminder",
      "**`>afk off to lunch`** sets the reason instead of clearing AFK",
      "AFK mention notices cap at 10 per message — a mass-mention can't overflow the embed anymore",
      "`/boot` panel restarts flush the log mirror; Ctrl+C during startup cleans up too",
      "Leaving a server now prunes orphaned rows; `>choose` rejects 11+ options loudly",
      "15 bugs fixed in total, all regression-tested — see CHANGELOG.md for the rest",
    ],
  },
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
  surface: "prefix-only",
  name: "changelog",
  usage: "changelog",
  description: "See what's new in the latest releases.",
  details:
    "The recent release notes, in-chat: version, date, and the highlights that " +
    "matter. The full history lives in the repository's CHANGELOG.md.",
  cooldownSeconds: 5,

  prefixNames: ["changelog", "changes"],
  async prefixExecute(message: Message) {
    log.info("PREFIX", `>changelog invoked by ${message.author.tag} (${message.author.id})`);
    await message.reply({ embeds: [buildChangelogEmbed()] });
  },
};

export default command;
