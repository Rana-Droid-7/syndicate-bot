import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Command } from "../../types/command.js";
import { baseEmbed, errorEmbed, successEmbed, warnEmbed } from "../../lib/embeds.js";
import { isDeveloper } from "../../lib/permissions.js";
import { announceOffline } from "../../lib/devlog.js";
import { triggerSoftRestart } from "../../lib/restartHook.js";
import { gracefulExit } from "../../lib/shutdown.js";
import { log } from "../../core/logger.js";

const PANEL_TIMEOUT_MS = 60_000;

/**
 * /boot — a single developer command. Instead of fixed subcommands,
 * it DMs the invoking developer a private button panel:
 *   🔄 Reboot  |  🛑 Shutdown  |  ❌ Cancel
 * The DM is private by nature (nobody else can even see it, let
 * alone click the buttons), and only the panel's owner's clicks are
 * accepted. The channel where /boot was run just gets a discreet
 * ephemeral note saying where the panel went.
 *
 * Reboot exits with code 1 so a process manager (PM2, systemd,
 * Docker restart policy) brings the bot back; Shutdown exits 0 and
 * stays down until manually started. Both announce to the dev-log
 * channel before disconnecting, and "online" is announced on the
 * next startup (see ready.ts / devlog.ts).
 */
const command: Command = {
  category: "owner",
  surface: "slash-only",
  usage: "/boot",
  description: "Reboot or shut down the bot — from a private DM panel.",
  details:
    "Process control for the bot's developers only, gated by trusted user IDs in " +
    "code — never roles, because a role from some other server must never control " +
    "the whole bot. Running it DMs you a private button panel: **Reboot** recycles " +
    "the connection in-process and comes back within seconds — it works under " +
    "`npm run dev`, bare `node`, and process managers alike. **Shutdown** stays " +
    "down until started manually. Both announce to the dev-log channel before " +
    "disconnecting.",
  data: new SlashCommandBuilder()
    .setName("boot")
    .setDescription("Control the bot process — sends you a private button panel in your DMs. (Developer only)")
    // Administrator here is just a UI-level filter to reduce clutter
    // in the command picker for ordinary members. It is NOT the
    // security boundary — the isDeveloper() check below is.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction: ChatInputCommandInteraction) {
    log.info("OWNER", `/boot invoked by ${interaction.user.tag} (${interaction.user.id})`);

    // The ONLY real security boundary for this command. Checked
    // against a hardcoded user ID list — completely independent of
    // this server's roles or permissions, because this command
    // controls the bot process globally, not just this guild.
    if (!isDeveloper(interaction.user.id)) {
      log.warn("OWNER", `/boot DENIED — ${interaction.user.id} is not a developer.`);
      await interaction.reply({ embeds: [errorEmbed("You're not authorized to use this command.")], flags: MessageFlags.Ephemeral });
      return;
    }

    // Build the panel up front so the DM can be sent complete in
    // one call (an empty placeholder message would fail validation).
    const panelEmbed = () =>
      baseEmbed()
        .setTitle("🛠️ Syndicate Bot — Process Control")
        .setDescription(
          `What would you like to do? This panel is private to **${interaction.user.tag}** and expires in 60 seconds.\n\n` +
            `🔄 **Reboot** — in-process restart: I recycle my connection and come back within seconds (no process manager needed)\n` +
            `🛑 **Shutdown** — clean disconnect and stay down until started manually\n` +
            `❌ **Cancel** — do nothing`,
        );

    const buttons = () => [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("boot-reboot").setLabel("Reboot").setEmoji("🔄").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("boot-shutdown").setLabel("Shutdown").setEmoji("🛑").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("boot-cancel").setLabel("Cancel").setEmoji("❌").setStyle(ButtonStyle.Secondary),
      ),
    ];

    // Try to DM the panel. If DMs are closed, say so clearly in the
    // channel where the command was run (ephemerally).
    const dm = await interaction.user
      .send({ embeds: [panelEmbed()], components: buttons() })
      .catch((err) => {
        log.warn("OWNER", `Failed to DM boot panel to ${interaction.user.id}`, err);
        return null;
      });

    if (!dm) {
      await interaction.reply({
        embeds: [warnEmbed("I couldn't DM you — open your DMs (Server → Privacy, or this server's settings) and try again.")],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      embeds: [successEmbed("Sent you a private boot panel in your DMs — check your messages.")],
      flags: MessageFlags.Ephemeral,
    });

    log.debug("OWNER", `Boot panel DM sent to ${interaction.user.id} (message ${dm.id}).`);

    const collector = dm.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: PANEL_TIMEOUT_MS,
      // At most one panel click is ever acted on — same protection
      // confirm.ts gives confirmation dialogs. A rapid double-click
      // on Reboot/Shutdown must never double-announce or race the
      // shutdown sequence.
      max: 1,
    });

    let settled = false;

    collector.on("collect", async (i: ButtonInteraction) => {
      // Only the panel owner's clicks count. In a DM there's
      // realistically nobody else, but the guarantee costs nothing.
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: "This panel isn't yours.", flags: MessageFlags.Ephemeral }).catch(() => null);
        return;
      }

      // Guard first and act BEFORE any await: with max:1 the second
      // click of a rapid double-click isn't collected at all, but a
      // click racing the collector's 'end' (expiry tick) can still
      // slip through — settled closes that window for good.
      if (settled) {
        log.warn("OWNER", "Boot panel click after already settled — ignoring.");
        return;
      }
      settled = true;

      const choice = i.customId;
      log.info("OWNER", `Boot panel: ${interaction.user.tag} (${interaction.user.id}) chose "${choice}".`);

      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buttons()[0].components.map((b) => ButtonBuilder.from(b).setDisabled(true)),
      );

      if (choice === "boot-cancel") {
        await i
          .update({
            embeds: [panelEmbed().setDescription("Cancelled — nothing was changed. Run `/boot` again anytime.")],
            components: [disabledRow],
          })
          .catch((err) => log.error("OWNER", "Failed to update boot panel on cancel", err));
        return;
      }

      const action = choice === "boot-reboot" ? "Reboot" : "Shutdown";
      await i
        .update({
          embeds: [
            baseEmbed()
              .setTitle(`🔄 ${action} Confirmed`)
              .setDescription(
                action === "Reboot"
                  ? "Rebooting now — recycling my connection in-process. I'll be back online in seconds and announce it."
                  : "Shutting down now. I'll stay offline until started manually.",
              ),
          ],
          components: [disabledRow],
        })
        .catch((err) => log.error("OWNER", `Failed to update boot panel on ${action}`, err));

      if (action === "Reboot") {
        // In-process soft restart: works under `npm run dev` and bare
        // `node` alike — no process manager required. The 30-minute
        // exit-code-1 contract remains ONLY as the fallback if the
        // in-process restart fails (see softRestart in index.ts).
        triggerSoftRestart("/boot DM panel", interaction.user.tag);
        return;
      }

      // Announce to the dev-log channel BEFORE disconnecting, so the
      // "going offline" message actually makes it out the door.
      await announceOffline(
        interaction.client,
        "Shutdown requested via /boot panel",
        `${interaction.user.tag} (\`${interaction.user.id}\`)`,
      );

      // The shared graceful-exit path (identical cleanup ordering as
      // the signal handlers in index.ts).
      await gracefulExit(interaction.client, {
        reboot: false,
        reason: "/boot DM panel",
        requestedBy: interaction.user.tag,
      });
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "time" && !settled) {
        log.info("OWNER", `Boot panel for ${interaction.user.id} expired after ${PANEL_TIMEOUT_MS}ms.`);
        await dm
          .edit({
            embeds: [panelEmbed().setDescription("⌛ Panel expired — nothing was done. Run `/boot` again anytime.")],
            components: [],
          })
          .catch((err) => log.error("OWNER", "Failed to expire boot panel", err));
      }
    });
  },
};

export default command;
