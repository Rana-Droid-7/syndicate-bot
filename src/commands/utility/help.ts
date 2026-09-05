import {
  MessageFlags,
  ComponentType,
  PermissionFlagsBits,
  type EmbedBuilder,
  type Message,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Command, CommandCategory } from "../../types/command.js";
import type { SyndicateClient } from "../../core/client.js";
import { config } from "../../core/config.js";
import { log } from "../../core/logger.js";
import { errorEmbed, baseEmbed } from "../../lib/embeds.js";
import {
  buildHelpHomeEmbed,
  buildCategoryEmbed,
  buildCommandDetailEmbed,
  buildCategorySelectRow,
  buildInviteButtonRow,
  type HelpViewer,
} from "../../lib/help.js";
import { findClosestMatch, findStartsWithMatches, type SuggestionCandidate } from "../../lib/suggest.js";

const COLLECTOR_TIMEOUT_MS = 180_000;

/** Smart not-found page: closest typo match + starts-with siblings. */
function buildUnknownCommandEmbed(
  client: SyndicateClient,
  viewer: HelpViewer,
  query: string,
  prefix: string,
): EmbedBuilder {
  const candidates = visibleCandidates(client, viewer);

  // 1) Did they mean X? — closest visible command by edit distance.
  const closest = findClosestMatch(candidates, query.toLowerCase());
  if (closest) {
    const name = closest.name ?? closest.data?.name ?? "?";
    return errorEmbed(
      `I don't know a command called \`${prefix}${query}\` — did you mean **${name}**?`,
    ).addFields({ name: "Try this", value: `\`${prefix}help ${name}\``, inline: false });
  }

  // 2) Anything that starts with (or contains) the query?
  const starts = findStartsWithMatches(candidates, query.toLowerCase());
  if (starts.length > 0) {
    const lines = starts
      .slice(0, 8)
      .map((m) => {
        const c = m.command as Command;
        const n = c.name ?? c.data?.name ?? "?";
        const typed = c.surface === "slash-only" ? `/${n}` : `${prefix}${n}`;
        return `• **${typed}** — _${c.description}_`;
      })
      .join("\n");
    return errorEmbed(`I don't know a command called \`${prefix}${query}\` — but these look close:`).setDescription(
      `I don't know \`${prefix}${query}\`, but these look close:\n\n${lines}`,
    );
  }

  // 3) Nothing close — point at the menu.
  return baseEmbed()
    .setColor(0xed4245)
    .setDescription(
      `❌ I don't know a command called \`${prefix}${query}\`.\n\n` +
        `Run \`${prefix}help\` and browse the categories to see everything I can do.`,
    );
}

/** Commands visible to this viewer for lookup purposes (admin/owner filtered). */
function visibleCandidates(client: SyndicateClient, viewer: HelpViewer): SuggestionCandidate[] {
  const isAdmin = viewer.isAdminHere ?? false;
  const isDev = config.developerIds.includes(viewer.userId);
  return client.suggestionCandidates.filter((c) => {
    if (c.command.category === "admin") return isAdmin;
    if (c.command.category === "owner") return isDev;
    return true;
  });
}

const command: Command = {
  category: "utility",
  surface: "prefix-only",
  name: "help",
  usage: "help [command]",
  description: "The command center — browse categories or look up any command.",
  details:
    "Your map to everything. No argument opens the interactive command center: " +
    "a home card with every category, a select menu to browse them, and an invite " +
    "button. Give it a command name (`help remindme`) for the full guide — what " +
    "it does, how it behaves, exact usage, aliases, examples, and cooldown. " +
    "Admin and developer sections only appear for people who can use them. " +
    "Typos are forgiven: `help halp` knows what you meant.",
  cooldownSeconds: 3,

  prefixNames: ["help", "commands", "h"],
  async prefixExecute(message: Message, args: string[]) {
    const client = message.client as SyndicateClient;
    const viewer: HelpViewer = {
      userId: message.author.id,
      isAdminHere: message.member?.permissions.has(PermissionFlagsBits.Administrator) ?? false,
    };

    // >help <command> — detail page
    const commandName = args[0]?.toLowerCase();
    if (commandName) {
      log.info("HELP", `>help detail requested by ${message.author.id}: "${commandName}"`);
      const detail = buildCommandDetailEmbed(client, commandName, viewer);
      if (!detail) {
        await message.reply({ embeds: [buildUnknownCommandEmbed(client, viewer, commandName, config.prefix)] });
        return;
      }
      await message.reply({ embeds: [detail] });
      return;
    }

    log.info("HELP", `>help menu opened by ${message.author.tag} (${message.author.id})`);
    await sendHomeMenuPrefix(message, client, viewer);
  },
};

async function sendHomeMenuPrefix(
  message: Message,
  client: SyndicateClient,
  viewer: HelpViewer,
) {
  const row = buildCategorySelectRow(client, viewer);
  const inviteRow = buildInviteButtonRow();

  const sent = await message.reply({ embeds: [buildHelpHomeEmbed(client, viewer)], components: [row, inviteRow] });

  const collector = sent.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: COLLECTOR_TIMEOUT_MS,
  });

  collector.on("collect", async (i: StringSelectMenuInteraction) => {
    try {
      if (i.user.id !== message.author.id) {
        await i.reply({ content: "This help menu isn't yours — run the help command to get your own!", flags: MessageFlags.Ephemeral });
        return;
      }

      const choice = i.values[0];
      const embed =
        choice === "home"
          ? buildHelpHomeEmbed(client, viewer)
          : buildCategoryEmbed(client, choice as CommandCategory);

      await i.update({ embeds: [embed], components: [row, inviteRow] });
    } catch (error) {
      log.error("HELP", "Failed to handle select menu interaction", error);
    }
  });

  collector.on("end", () => {
    sent.edit({ components: [] }).catch(() => null);
  });
}

export default command;
