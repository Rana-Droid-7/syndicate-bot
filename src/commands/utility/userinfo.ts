import { MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type GuildMember,
  type User,
  type UserFlags,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed } from "../../lib/embeds.js";
import { mentionToId, isSnowflake } from "../../lib/validation.js";
import { discordTimestamp } from "../../lib/format.js";
import { log } from "../../core/logger.js";

const ROLES_FIELD_MAX_LENGTH = 1000; // stay under Discord's 1024 hard cap with margin

type BadgeFlag = keyof typeof UserFlags;

// Discord's actual badge flags, mapped to display emojis. Anything
// unmapped is skipped rather than shown as a raw flag name.
const BADGE_EMOJIS: Partial<Record<BadgeFlag, string>> = {
  ActiveDeveloper: "🧑‍💻",
  BugHunterLevel1: "🐛",
  BugHunterLevel2: "🐞",
  CertifiedModerator: "🛡️",
  Collaborator: "🤝",
  Hypesquad: "🎪",
  HypeSquadOnlineHouse1: "🟪",
  HypeSquadOnlineHouse2: "🟧",
  HypeSquadOnlineHouse3: "🟩",
  PremiumEarlySupporter: "💠",
  VerifiedBot: "✅🤖",
  VerifiedDeveloper: "✅👨‍💻",
  Partner: "🏆",
  Staff: "🧑‍💼",
};

function buildRolesValue(roles: string[]): string {
  if (roles.length === 0) return "None";

  let value = "";
  let shown = 0;
  for (const role of roles) {
    const candidate = value ? `${value} ${role}` : role;
    if (candidate.length > ROLES_FIELD_MAX_LENGTH) break;
    value = candidate;
    shown++;
  }

  if (shown < roles.length) {
    value += `\n_...and ${roles.length - shown} more_`;
  }

  return value;
}

function buildBadgesValue(flags: readonly BadgeFlag[] | null): string {
  if (!flags || flags.length === 0) return "None";
  const badges = flags.map((f) => BADGE_EMOJIS[f]).filter(Boolean);
  return badges.length > 0 ? badges.join(" ") : "None";
}

export async function buildUserInfoEmbed(member: GuildMember): Promise<{ embed: ReturnType<typeof baseEmbed>; hasBanner: boolean }> {
  const user = member.user;

  // banner + flags only arrive from a REST user fetch — the cached
  // member payload doesn't carry them.
  const fetchedUser: User | null = await user.fetch().catch(() => null);
  const bannerUrl = fetchedUser?.bannerURL({ size: 1024 }) ?? null;
  const flags = fetchedUser?.flags?.toArray() ?? null;

  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => `<@&${r.id}>`);

  const joinedUnix = member.joinedTimestamp ? Math.floor(member.joinedTimestamp / 1000) : null;
  const createdUnix = Math.floor(user.createdTimestamp / 1000);
  const boostUnix = member.premiumSinceTimestamp
    ? Math.floor(member.premiumSinceTimestamp / 1000)
    : null;

  const embed = baseEmbed()
    .setTitle(`${user.username}`)
    .setThumbnail(user.displayAvatarURL({ size: 512 }))
    .setColor(member.displayColor || 0x5865f2)
    .addFields(
      { name: "User ID", value: `\`${user.id}\``, inline: true },
      { name: "Bot Account", value: user.bot ? "Yes" : "No", inline: true },
      { name: "Badges", value: buildBadgesValue(flags), inline: true },
      { name: "Nickname", value: member.nickname ?? "None", inline: true },
      {
        name: "Account Created",
        value: `${discordTimestamp(createdUnix, "F")}\n${discordTimestamp(createdUnix, "R")}`,
        inline: true,
      },
      {
        name: "Joined Server",
        value: joinedUnix
          ? `${discordTimestamp(joinedUnix, "F")}\n${discordTimestamp(joinedUnix, "R")}`
          : "Unknown",
        inline: true,
      },
    );

  if (boostUnix) {
    embed.addFields({
      name: "Boosting Since",
      value: `${discordTimestamp(boostUnix, "F")}\n${discordTimestamp(boostUnix, "R")}`,
      inline: true,
    });
  }

  embed.addFields({
    name: `Roles (${roles.length})`,
    // Truncated to stay under Discord's 1024-char field-value limit —
    // a member with ~40+ roles would otherwise overflow it and the
    // whole reply would throw when discord.js validates the embed.
    value: buildRolesValue(roles),
    inline: false,
  });

  if (bannerUrl) embed.setImage(bannerUrl);

  embed.setFooter({ text: "Timestamps shown adjust automatically to your local timezone." });

  return { embed, hasBanner: !!bannerUrl };
}

const command: Command = {
  category: "utility",
  surface: "both",
  usage: ">userinfo [@user]",
  cooldownSeconds: 3,
  data: new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Show info about a server member.")
    .addUserOption((opt) =>
      opt.setName("target").setDescription("The member to look up (defaults to you)").setRequired(false),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: "This command only works in a server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const targetUser = interaction.options.getUser("target") ?? interaction.user;
    log.info("CMD", `/userinfo invoked by ${interaction.user.tag} (${interaction.user.id}) for target ${targetUser.id}`);
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
      await interaction.reply({ content: "Couldn't find that member in this server.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ embeds: [(await buildUserInfoEmbed(member)).embed] });
  },

  prefixNames: ["userinfo", "whois", "ui"],
  async prefixExecute(message: Message, args: string[]) {
    if (!message.guild) return;

    // Same validation style as >avatar/>banner: an argument that
    // isn't a mention or a plain ID gets a clear message, not a
    // generic "couldn't find that member".
    if (args.length > 0 && !message.mentions.users.size) {
      const candidate = mentionToId(args[0]);
      if (!isSnowflake(candidate)) {
        await message.reply(`\`${args[0]}\` doesn't look like a valid user mention or ID.`);
        return;
      }
    }

    const targetId = message.mentions.users.first()?.id ?? (args[0] ? mentionToId(args[0]) : message.author.id);
    log.info("PREFIX", `>userinfo invoked by ${message.author.tag} (${message.author.id}) for target ${targetId}`);
    const member = await message.guild.members.fetch(targetId).catch(() => null);

    if (!member) {
      await message.reply("Couldn't find that member in this server.");
      return;
    }

    await message.reply({ embeds: [(await buildUserInfoEmbed(member)).embed] });
  },
};

export default command;
