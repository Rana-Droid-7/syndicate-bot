import { type Message, PermissionFlagsBits } from "discord.js";
import type { BotEvent } from "../handlers/eventHandler.js";
import type { SyndicateClient } from "../core/client.js";
import { config } from "../core/config.js";
import { baseEmbed, errorEmbed } from "../lib/embeds.js";
import { discordTimestamp, formatDuration } from "../lib/format.js";
import {
  findClosestMatch,
  findStartsWithMatches,
  formatLookupDescription,
  MIN_SUGGESTION_LENGTH,
  type SuggestionCandidate,
} from "../lib/suggest.js";
import { parseQuotedArgs, escapeMarkdownBold } from "../lib/validation.js";
import { cooldowns } from "../lib/cooldowns.js";
import {
  BotError,
  CooldownError,
  ContextError,
  DatabaseError,
  PermissionError,
  UserInputError,
} from "../lib/errors.js";
import { afkService } from "../services/afk.js";
import { log } from "../core/logger.js";

// One AFK mention-notice per channel per AFK user per minute —
// without this, mentioning an AFK member on every message makes
// the bot amplify it into a reply every time.
const AFK_NOTICE_COOLDOWN_MS = 60_000;
// Cooldown keys accumulate; sweep expired ones periodically.
const COOLDOWN_SWEEP_INTERVAL_MS = 300_000;

const afkNoticeLastSent = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, at] of afkNoticeLastSent) {
    if (now - at >= AFK_NOTICE_COOLDOWN_MS) afkNoticeLastSent.delete(key);
  }
  cooldowns.sweep();
}, COOLDOWN_SWEEP_INTERVAL_MS).unref();

/** Visible suggestion candidates for this viewer (admin/owner filtered). */
function visibleCandidates(client: SyndicateClient, message: Message): SuggestionCandidate[] {
  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false;
  const isDev = config.developerIds.includes(message.author.id);
  return client.suggestionCandidates.filter((c) => {
    if (c.command.category === "admin") return isAdmin;
    if (c.command.category === "owner") return isDev;
    return true;
  });
}

const event: BotEvent<"messageCreate"> = {
  name: "messageCreate",
  async execute(message: Message) {
    if (message.author.bot || !message.guild) return;

    const client = message.client as SyndicateClient;
    const guildId = message.guild.id;

    // ================= AFK lifecycle =================
    // Resolving whether this message invokes ">afk" itself: re-running
    // the AFK command must NOT trigger "welcome back" first — it's an
    // update/toggle, not a return.
    let invokedCommandName: string | null = null;
    if (message.content.startsWith(config.prefix)) {
      const firstToken = message.content.slice(config.prefix.length).trim().split(/\s+/)[0];
      const resolved = firstToken ? client.prefixCommands.get(firstToken.toLowerCase()) : undefined;
      invokedCommandName = resolved?.data?.name ?? resolved?.name ?? null;
    }
    const isReAfkCommand = invokedCommandName === "afk";

    if (!isReAfkCommand) {
      try {
        // Hot path: every message runs this — the in-memory index
        // makes it a Map lookup; the DB is only touched on a hit.
        if (afkService.isAfk(guildId, message.author.id)) {
          const cleared = afkService.clear(guildId, message.author.id);
          if (cleared) {
            await message
              .reply({
                embeds: [
                  baseEmbed().setDescription(
                    `👋 Welcome back, ${message.author}! I removed your AFK status.\n` +
                      `You were away for **${formatDuration(cleared.awayMs)}**.`,
                  ),
                ],
              })
              .catch((err) => log.error("AFK", "Failed to send welcome-back message", err));
          }
        }
      } catch (error) {
        log.error("AFK", "Error in self-AFK-removal check", error);
      }
    } else {
      log.debug("AFK", `${message.author.tag} is re-running >afk — skipping welcome-back notification.`);
    }

    // AFK mention notices — per-guild, cooldown-throttled, index-first.
    try {
      if (message.mentions.users.size > 0 && afkService.hasAnyAfk(guildId)) {
        const mentionedIds = [...message.mentions.users.keys()];
        const afkTargets = afkService.forMentions(guildId, mentionedIds);
        const notices: string[] = [];

        for (const [userId, status] of afkTargets) {
          const key = `${guildId}:${message.channelId}:${userId}`;
          const last = afkNoticeLastSent.get(key) ?? 0;
          if (Date.now() - last < AFK_NOTICE_COOLDOWN_MS) continue;
          afkNoticeLastSent.set(key, Date.now());
          notices.push(
            `**${escapeMarkdownBold(message.mentions.users.get(userId)?.username ?? "Someone")}** is AFK: ${status.reason} (since ${discordTimestamp(Math.floor(status.sinceUnixMs / 1000), "R")})`,
          );
        }

        if (notices.length > 0) {
          await message
            .reply({ embeds: [baseEmbed().setDescription(notices.join("\n"))] })
            .catch((err) => log.error("AFK", "Failed to send AFK-mention notice", err));
        }
      }
    } catch (error) {
      log.error("AFK", "Error in AFK-mention check", error);
    }

    // ================= Prefix dispatch =================
    if (!message.content.startsWith(config.prefix)) return;

    const afterPrefix = message.content.slice(config.prefix.length);
    const { args } = parseQuotedArgs(afterPrefix);
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) return; // bare ">" — not a command

    const command = client.prefixCommands.get(commandName);

    // ---- known command: dispatch with cooldown + error taxonomy ----
    if (command?.prefixExecute) {
      log.info(
        "PREFIX",
        `${config.prefix}${commandName} dispatched — user=${message.author.tag} (${message.author.id}), ` +
          `guild=${guildId}, channel=${message.channelId}, args=${JSON.stringify(args)}`,
      );

      try {
        cooldowns.check(guildId, message.author.id, command.name ?? command.data?.name ?? "?", command.cooldownSeconds ?? 0);
        await command.prefixExecute(message, args);
      } catch (error) {
        await handleCommandError(message, error, `${config.prefix}${commandName}`);
      }
      return;
    }

    // ---- slash-only attempts: explain with usage ----
    const slashOnly = client.slashCommands.get(commandName);
    if (client.slashOnlyCommands.has(commandName) && slashOnly && !("contextMenu" in slashOnly)) {
      log.debug("PREFIX", `${config.prefix}${commandName} is slash-only — replying with an explanation.`);
      const cmd = slashOnly as { usage: string; category: string };
      await message
        .reply({
          embeds: [
            errorEmbed(
              `**/${commandName}** is a slash-only command — it doesn't work with the \`${config.prefix}\` prefix.` +
                (cmd.category === "owner" ? "\nIt also requires developer permissions." : ""),
            ).addFields({ name: "Correct usage", value: `\`${cmd.usage}\` — type it as a native slash command.`, inline: false }),
          ],
        })
        .catch((err) => log.error("PREFIX", "Failed to send slash-only explanation", err));
      return;
    }

    // ---- unknown: starts-with lookup, then typo suggestion ----
    if (commandName.length <= 20 && /^[a-z0-9]+$/i.test(commandName)) {
      const candidates = visibleCandidates(client, message);

      const startsWith = findStartsWithMatches(candidates, commandName);
      if (startsWith.length > 0) {
        const list = formatLookupDescription(startsWith);
        log.info("PREFIX", `${config.prefix}${commandName} unknown — listed ${list.shown}/${list.total} starts-with match(es).`);
        await message
          .reply({
            embeds: [
              baseEmbed()
                .setTitle(`🔍 Commands matching \`${config.prefix}${commandName}\``)
                .setDescription(
                  `I don't know a command called \`${config.prefix}${commandName}\`, but here's everything that starts with it:\n\n` +
                    list.description,
                )
                .setFooter({ text: `Tip: >help <command> shows detailed usage for any of them.` }),
            ],
          })
          .catch((err) => log.error("PREFIX", "Failed to send starts-with lookup", err));
        return;
      }

      if (commandName.length >= MIN_SUGGESTION_LENGTH) {
        const suggestion = findClosestMatch(candidates, commandName);
        if (suggestion) {
          log.info("PREFIX", `${config.prefix}${commandName} looks like a typo of "${suggestion.name ?? suggestion.data?.name ?? "?"}" — suggesting it.`);
          await message
            .reply({
              embeds: [
                errorEmbed(
                  `I don't know a command called \`${config.prefix}${commandName}\` — did you mean **${suggestion.name ?? suggestion.data?.name ?? "?"}**?`,
                ).addFields({ name: "Correct usage", value: `\`${suggestion.usage}\``, inline: false }),
              ],
            })
            .catch((err) => log.error("PREFIX", "Failed to send typo suggestion", err));
          return;
        }
      }
    }

    // Nothing matched — leave it alone; could be prose starting with ">".
  },
};

/** Maps the error taxonomy to styled, informative user replies. */
async function handleCommandError(message: Message, error: unknown, label: string): Promise<void> {
  if (error instanceof CooldownError) {
    await message.reply({ embeds: [errorEmbed(error.message)] }).catch(() => null);
    return;
  }
  if (error instanceof UserInputError) {
    const embed = errorEmbed(error.message);
    if (error.usage) embed.addFields({ name: "Correct usage", value: `\`${error.usage}\``, inline: false });
    await message.reply({ embeds: [embed] }).catch(() => null);
    return;
  }
  if (error instanceof PermissionError) {
    await message.reply({ embeds: [errorEmbed(error.message)] }).catch(() => null);
    return;
  }
  if (error instanceof ContextError) {
    await message.reply({ embeds: [errorEmbed(error.message)] }).catch(() => null);
    return;
  }
  if (error instanceof DatabaseError) {
    log.error("PREFIX", `Database failure during ${label}`, error);
    await message
      .reply({ embeds: [errorEmbed("Something's wrong with my storage — the developer has been notified. Try again in a moment.")] })
      .catch(() => null);
    return;
  }
  if (error instanceof BotError) {
    await message.reply({ embeds: [errorEmbed(error.message)] }).catch(() => null);
    return;
  }

  // Unknown/unexpected: full log, generic clean user message.
  log.error("PREFIX", `Error executing ${label}`, error);
  await message
    .reply({ embeds: [errorEmbed("Something went wrong running that command.")] })
    .catch((err) => log.error("PREFIX", "Also failed to notify the user about the error", err));
}

export default event;
