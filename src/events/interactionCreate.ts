import { MessageFlags, type ChatInputCommandInteraction, type Interaction, type UserContextMenuCommandInteraction } from "discord.js";
import type { BotEvent } from "../handlers/eventHandler.js";
import type { SyndicateClient } from "../core/client.js";
import { config } from "../core/config.js";
import { baseEmbed, errorEmbed } from "../lib/embeds.js";
import { sendDevLog } from "../lib/devlog.js";
import { cooldowns } from "../lib/cooldowns.js";
import { mapErrorToReply } from "../lib/errors.js";
import { ContextError } from "../lib/errors.js";
import { errorDetail } from "../lib/safeError.js";
import { log } from "../core/logger.js";

const event: BotEvent<"interactionCreate"> = {
  name: "interactionCreate",
  async execute(interaction: Interaction) {
    // Button/select interactions are handled locally by each command's
    // own collector. This dispatches slash and right-click commands.
    let commandInteraction: ChatInputCommandInteraction | UserContextMenuCommandInteraction;
    let isContextMenu: boolean;
    if (interaction.isUserContextMenuCommand()) {
      commandInteraction = interaction;
      isContextMenu = true;
    } else if (interaction.isChatInputCommand()) {
      commandInteraction = interaction;
      isContextMenu = false;
    } else {
      return;
    }

    const client = commandInteraction.client as SyndicateClient;
    const command = client.slashCommands.get(commandInteraction.commandName);

    // Unknown command, or a kind mismatch — treat as unknown either way.
    if (!command || isContextMenu !== ("contextMenu" in command)) {
      log.warn("EVENT", `Unknown command received: ${commandInteraction.commandName}`);
      await commandInteraction
        .reply({
          embeds: [
            errorEmbed(
              `I don't recognize **/${commandInteraction.commandName}** — it may have been renamed or removed, or the update hasn't reached Discord yet (can take up to an hour).`,
            ).setFooter({ text: `Public commands now live on the ${config.prefix} prefix — try ${config.prefix}help` }),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch((err) => log.error("EVENT", "Failed to reply about unknown command", err));
      return;
    }

    log.info(
      "CMD",
      `${isContextMenu ? "context" : "/"}${commandInteraction.commandName} dispatched — user=${commandInteraction.user.tag} (${commandInteraction.user.id}), ` +
        `guild=${commandInteraction.guildId ?? "DM"}, channel=${commandInteraction.channelId}`,
    );

    try {
      // Context-menu and prefix-only commands never reach cooldowns here;
      // slash commands get the same per-user cooldown as the prefix.
      if (!isContextMenu) {
        cooldowns.check(
          commandInteraction.guildId,
          commandInteraction.user.id,
          commandInteraction.commandName,
          (command as { cooldownSeconds?: number }).cooldownSeconds ?? 0,
        );
      }

      // The isContextMenu check above guarantees command kind matches
      // interaction kind, so these casts are safe at runtime.
      if ("contextMenu" in command) {
        await command.execute(commandInteraction as UserContextMenuCommandInteraction);
      } else {
        const cmd = command as { execute?: (i: ChatInputCommandInteraction) => Promise<void> };
        if (!cmd.execute) throw new ContextError("This command doesn't run as a slash command.");
        await cmd.execute(commandInteraction as ChatInputCommandInteraction);
      }
    } catch (error) {
      await handleSlashError(commandInteraction, error, commandInteraction.commandName);
    }
  },
};

/** Maps the error taxonomy to styled ephemeral replies + devlogs. */
async function handleSlashError(
  interaction: ChatInputCommandInteraction | UserContextMenuCommandInteraction,
  error: unknown,
  name: string,
): Promise<void> {
  log.error("CMD", `Error executing ${name}`, error);

  const reply = (description: string) =>
    (interaction.replied || interaction.deferred
      ? interaction.followUp({ embeds: [errorEmbed(description)], flags: MessageFlags.Ephemeral })
      : interaction.reply({ embeds: [errorEmbed(description)], flags: MessageFlags.Ephemeral })
    ).catch((replyError) =>
      log.error("CMD", `Also failed to notify user about /${name} error (token likely expired)`, replyError),
    );

  const mapped = mapErrorToReply(error);

  if (mapped) {
    if (mapped.usage) {
      const embed = errorEmbed(mapped.description).addFields({ name: "Correct usage", value: `\`${mapped.usage}\``, inline: false });
      await (interaction.replied || interaction.deferred
        ? interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral })
        : interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
      ).catch(() => null);
    } else {
      await reply(mapped.description);
    }
    if (mapped.notifyDeveloper) {
      await sendDevLog(
        interaction.client,
        baseEmbed()
          .setTitle("⚠️ Database Error")
          .addFields(
            { name: "Surface", value: "slash", inline: true },
            { name: "Command", value: `/${name}`, inline: true },
            { name: "Detail", value: `\`\`\`${errorDetail(error)}\`\`\``, inline: false },
          ),
      ).catch((devlogError) => log.error("CMD", "Failed to send devlog for database error", devlogError));
    }
    return;
  }

  await reply("Something went wrong running that command.");

  // Full detail to the dev channel for anything unexpected.
  const client = interaction.client;
  await sendDevLog(
    client,
    baseEmbed()
      .setTitle("⚠️ Command Error")
      .addFields(
        { name: "Command", value: `/${name}`, inline: true },
        { name: "User", value: `${interaction.user.tag} (\`${interaction.user.id}\`)`, inline: true },
        { name: "Server", value: interaction.guild ? `${interaction.guild.name} (\`${interaction.guild.id}\`)` : "DM", inline: false },
        { name: "Error", value: `\`\`\`${errorDetail(error)}\`\`\``, inline: false },
      ),
  ).catch((devlogError) => log.error("CMD", "Failed to send devlog for command error", devlogError));
}

export default event;
