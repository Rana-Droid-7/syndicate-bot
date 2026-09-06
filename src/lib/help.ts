import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type EmbedBuilder,
} from "discord.js";
import { baseEmbed } from "./embeds.js";
import { config } from "../core/config.js";
import { isDeveloper } from "./permissions.js";
import { buildInviteUrl } from "./invite.js";
import { log } from "../core/logger.js";
import type { SyndicateClient } from "../core/client.js";
import type { AnyCommand, Command, CommandCategory } from "../types/command.js";

// Discord embeds cap at 25 fields total. Category pages reserve one
// slot for the overflow note.
const MAX_CATEGORY_FIELDS = 24;

export const CATEGORY_META: Record<CommandCategory, { label: string; emoji: string; description: string; color: number }> = {
  utility: {
    label: "Utility",
    emoji: "🛠️",
    description: "Everyday tools and info. Open to everyone.",
    color: 0x5865f2,
  },
  coolsies: {
    label: "Coolsies",
    emoji: "🎉",
    description: "Fun, random, lightweight — dice, jokes, 8-ball, and more.",
    color: 0xeb459e,
  },
  moderation: {
    label: "Moderation",
    emoji: "🛡️",
    description: "Server moderation tools. Requires the matching Discord permission.",
    color: 0xed4245,
  },
  admin: {
    label: "Admin",
    emoji: "🔧",
    description: "Server configuration tools. Requires Administrator permission.",
    color: 0xf1c40f,
  },
  owner: {
    label: "Developer",
    emoji: "🔑",
    description: "Bot process control. Restricted to trusted developers only.",
    color: 0x2f3136,
  },
};

// Categories every member can see, in display order. "admin" and
// "owner" are added back in per-viewer below — a category that
// controls the whole server or the whole bot shouldn't be visible
// (or even hinted at) to people who can't use it.
const PUBLIC_ORDER: CommandCategory[] = ["utility", "coolsies", "moderation"];

export interface HelpViewer {
  userId: string;
  /** Whether this viewer has Administrator permission in THIS guild. False/omitted in DMs. */
  isAdminHere?: boolean;
}

/** Resolve a command's canonical name regardless of surface. */
export function commandName(command: AnyCommand): string {
  if (command.data) return command.data.name;
  const cmd = command as Command;
  return cmd.name ?? cmd.prefixNames?.[0] ?? "unknown";
}

/** Categories visible to this viewer, in display order, that actually have commands loaded. */
export function activeCategories(client: SyndicateClient, viewer?: HelpViewer): CommandCategory[] {
  const present = new Set<CommandCategory>();
  for (const command of client.slashCommands.values()) {
    present.add(command.category);
  }

  const order = [...PUBLIC_ORDER];
  if (viewer?.isAdminHere) order.push("admin");
  if (viewer && isDeveloper(viewer.userId)) order.push("owner");

  return order.filter((c) => present.has(c));
}

/** Sorted visible commands of one category. */
function categoryCommands(client: SyndicateClient, category: CommandCategory): AnyCommand[] {
  return [...client.slashCommands.values()]
    .filter((c) => c.category === category)
    .sort((a, b) => commandName(a).localeCompare(commandName(b)));
}

/**
 * Home page — a clean overview card. Not a wall of fields: brand
 * banner, quick-start hint, per-category one-liners with counts.
 */
export function buildHelpHomeEmbed(client: SyndicateClient, viewer?: HelpViewer): EmbedBuilder {
  const categories = activeCategories(client, viewer);

  const embed = baseEmbed()
    .setTitle(`${config.botName} — Command Center`)
    .setDescription(
      `A modern Discord utility & moderation bot.\n\n` +
        `**Get started:** public commands live on the \`${config.prefix}\` prefix — try \`${config.prefix}help <command>\` for exact usage. ` +
        `Rushing a command shows a live countdown until it's ready. ` +
        `Moderation and admin tools are native \`/\` slash commands.`,
    );

  if (client.user) embed.setThumbnail(client.user.displayAvatarURL());

  for (const category of categories) {
    const meta = CATEGORY_META[category];
    const count = client.slashCommands.filter((c) => c.category === category).size;
    embed.addFields({
      name: `${meta.emoji} ${meta.label} — ${count} command${count === 1 ? "" : "s"}`,
      value: meta.description,
      inline: false,
    });
  }

  embed.setFooter({ text: `${config.botName} • v${config.version} • select a category below` });
  return embed;
}

/** Surface badge shown next to each command in category listings. */
function surfaceBadge(command: AnyCommand): string {
  const cmd = command as Command;
  return cmd.surface === "prefix-only" ? `\`${config.prefix}\` prefix` : "slash-only";
}

/**
 * Category page — every command with its description and usage,
 * compact and scannable.
 */
export function buildCategoryEmbed(client: SyndicateClient, category: CommandCategory): EmbedBuilder {
  const meta = CATEGORY_META[category];
  const allCommands = categoryCommands(client, category);

  const embed = baseEmbed()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${meta.label} Commands`)
    .setDescription(`${meta.description}\n\n_Tip: \`${config.prefix}help <command>\` shows the full guide for any command._`);

  if (allCommands.length === 0) {
    embed.addFields({ name: "\u200b", value: "No commands in this category yet — check back in a future update." });
    return embed;
  }

  const shown = allCommands.slice(0, MAX_CATEGORY_FIELDS);
  if (shown.length < allCommands.length) {
    log.warn(
      "HELP",
      `Category "${category}" has ${allCommands.length} commands, exceeding the ${MAX_CATEGORY_FIELDS}-field display cap — truncating.`,
    );
  }

  for (const command of shown) {
    const cmd = command as Command;
    const name = commandName(command);
    const isSlash = cmd.surface === "slash-only";
    const fieldTitle = isSlash ? `/${name}` : `${config.prefix}${name}`;
    // Prefix commands store usage prefix-free; render with the env prefix.
    const usage = isSlash ? cmd.usage : `${config.prefix}${cmd.usage}`;
    embed.addFields({
      name: fieldTitle,
      value: `${cmd.description}\n\`${usage}\``,
      inline: false,
    });
  }

  if (shown.length < allCommands.length) {
    embed.addFields({
      name: "...",
      value: `And ${allCommands.length - shown.length} more command(s) in this category.`,
      inline: false,
    });
  }

  embed.setFooter({ text: `${config.botName} • v${config.version}` });
  return embed;
}

/**
 * Command detail page — one command, fully: description, usage,
 * aliases, examples, category, surface. Visibility mirrors the
 * category pages: admin details need Administrator, developer
 * details need developer status — anyone else gets null.
 */
export function buildCommandDetailEmbed(
  client: SyndicateClient,
  commandNameInput: string,
  viewer?: HelpViewer,
): EmbedBuilder | null {
  const command: AnyCommand | undefined =
    client.slashCommands.get(commandNameInput) ?? client.prefixCommands.get(commandNameInput);
  if (!command) return null;

  // Same visibility rules as the home/category pages.
  if (command.category === "admin" && !viewer?.isAdminHere) return null;
  if (command.category === "owner" && !(viewer && isDeveloper(viewer.userId))) return null;

  const meta = CATEGORY_META[command.category];
  const name = commandName(command);
  const cmd = command as Command;

  const typedName = cmd.surface === "slash-only" ? `/${name}` : `${config.prefix}${name}`;

  // Prefix commands store usage/examples prefix-FREE (loader-enforced);
  // render them with the env prefix so PREFIX=! in .env flips every
  // help display at once. Slash usage lines are literal command names.
  const render = (line: string) => (cmd.surface === "slash-only" ? line : `${config.prefix}${line}`);

  const embed = baseEmbed()
    .setColor(meta.color)
    .setTitle(`${meta.emoji} ${typedName}`)
    .setDescription(cmd.details ?? cmd.description);

  embed.addFields(
    { name: "Usage", value: `\`${render(cmd.usage)}\``, inline: false },
    { name: "Category", value: `${meta.emoji} ${meta.label}`, inline: true },
    { name: "Available as", value: surfaceBadge(command), inline: true },
  );

  const aliases =
    cmd.prefixNames && cmd.prefixNames.length > 1
      ? cmd.prefixNames.map((n) => `\`${config.prefix}${n}\``).join(", ")
      : null;
  if (aliases) {
    embed.addFields({ name: "Aliases", value: aliases, inline: false });
  }

  if (cmd.examples && cmd.examples.length > 0) {
    embed.addFields({
      name: "Examples",
      value: cmd.examples.map((e) => `\`${render(e)}\``).join("\n"),
      inline: false,
    });
  }

  if (cmd.cooldownSeconds && cmd.cooldownSeconds > 0) {
    embed.addFields({ name: "Cooldown", value: `${cmd.cooldownSeconds}s per user — with a live countdown if you retry early`, inline: true });
  }

  embed.setFooter({ text: `${config.botName} • v${config.version} • <> required, [] optional` });
  return embed;
}

export function buildCategorySelectRow(
  client: SyndicateClient,
  viewer?: HelpViewer,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const categories = activeCategories(client, viewer);

  const menu = new StringSelectMenuBuilder()
    .setCustomId("help-category-select")
    .setPlaceholder("Browse a category...")
    .addOptions(
      { label: "Home", value: "home", emoji: "🏠", description: "Overview of all categories" },
      ...categories.map((c) => ({
        label: CATEGORY_META[c].label,
        value: c,
        emoji: CATEGORY_META[c].emoji,
        description: CATEGORY_META[c].description.slice(0, 100),
      })),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

/** A link button to invite the bot — shown on /help's home view and /bot. */
export function buildInviteButtonRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(`Invite ${config.botName}`).setStyle(ButtonStyle.Link).setURL(buildInviteUrl()),
  );
}
