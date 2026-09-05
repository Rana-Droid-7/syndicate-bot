import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { baseEmbed } from "./embeds.js";
import { log } from "../core/logger.js";

const CONFIRM_TIMEOUT_MS = 30_000;

export interface ConfirmOptions {
  /**
   * Show the confirmation prompt (and result) only to the invoker.
   * Use this for anything where the public message itself could
   * interfere with the action — e.g. /purge's own confirmation
   * message is one of the most recent messages in the channel, so
   * a NON-ephemeral prompt would likely get swept up and deleted
   * by the very purge it just confirmed.
   */
  ephemeral?: boolean;
}

/**
 * Shows a Confirm/Cancel button prompt and resolves to true/false
 * based on what happens. Used before any destructive action
 * (kick, ban, timeout, purge, boot stop/restart, clearing warnings).
 *
 * Concurrency/identity guarantees this provides:
 *  - Only the original command invoker's clicks are ever collected.
 *    Anyone else who clicks gets an ephemeral "not for you" reply
 *    and their click is NOT counted — it can't consume the one
 *    allowed response or race the real invoker.
 *  - `max: 1` on the collector means at most one click is ever
 *    acted on. A rapid double-click (or a click arriving a moment
 *    after the first was already processed) simply isn't collected
 *    a second time — there is no path to double-executing the
 *    action or resolving this promise twice.
 *  - The buttons are disabled the instant a valid click is
 *    processed, closing the window for further clicks visually too.
 */
export async function confirmAction(
  interaction: ChatInputCommandInteraction,
  title: string,
  description: string,
  options: ConfirmOptions = {},
): Promise<boolean> {
  log.info(
    "CONFIRM",
    `Showing confirmation "${title}" to ${interaction.user.tag} (${interaction.user.id}) ` +
      `in guild ${interaction.guild?.id ?? "DM"}, ephemeral=${!!options.ephemeral}`,
  );

  const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("confirm-yes").setLabel("Confirm").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("confirm-no").setLabel("Cancel").setStyle(ButtonStyle.Secondary),
  );

  const response = await interaction.reply({
    embeds: [baseEmbed().setTitle(title).setDescription(description).setFooter({ text: "This confirmation expires in 30 seconds." })],
    components: [confirmRow],
    flags: options.ephemeral ? MessageFlags.Ephemeral : undefined,
    withResponse: true,
  });

  // The response should always carry the message resource for a
  // fresh reply — but a non-null assertion here would turn any djs
  // edge case into an uncaught throw inside every moderation command.
  // Degrade instead: no message means we can't collect a click, so
  // treat it exactly like a timeout (cancelled).
  const message = response.resource?.message ?? null;
  if (!message) {
    log.error("CONFIRM", "Confirmation reply carried no message resource — treating as cancelled.");
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: CONFIRM_TIMEOUT_MS,
      max: 1,
      // Async filter: interactions from anyone but the original
      // invoker are rejected here (with their own ephemeral reply)
      // and never reach "collect" — so they can't consume the
      // max:1 slot or race the real invoker's click.
      filter: async (i) => {
        if (i.user.id !== interaction.user.id) {
          log.warn(
            "CONFIRM",
            `Rejected click from ${i.user.tag} (${i.user.id}) — confirmation belongs to ${interaction.user.id}.`,
          );
          await i.reply({ content: "This confirmation isn't for you.", flags: MessageFlags.Ephemeral }).catch((err) =>
            log.error("CONFIRM", "Failed to send 'not for you' reply", err),
          );
          return false;
        }
        log.debug("CONFIRM", `Accepted click from the original invoker ${i.user.id}, customId=${i.customId}.`);
        return true;
      },
    });

    collector.on("collect", async (i) => {
      // Guard first, and resolve BEFORE any await. discord.js emits
      // 'collect' then immediately 'end' (max:1 reached) in the same
      // synchronous call stack — if we awaited i.update() before
      // setting `settled`, the 'end' handler below would run first
      // (since its check happens before our await resolves) and
      // incorrectly report "timed out" even though a real click just
      // came in. Resolving synchronously here closes that window.
      if (settled) {
        log.warn("CONFIRM", "Collect fired after already settled — ignoring (should be unreachable with max:1).");
        return;
      }
      const confirmed = i.customId === "confirm-yes";
      settled = true;
      log.info("CONFIRM", `"${title}" resolved: ${confirmed ? "CONFIRMED" : "CANCELLED"} by ${i.user.id}.`);
      resolve(confirmed);

      // Best-effort UI update from here on — any failure must never
      // affect the decision already resolved above.
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        confirmRow.components.map((b) => ButtonBuilder.from(b).setDisabled(true)),
      );

      try {
        await i.update({
          embeds: [
            baseEmbed()
              .setTitle(title)
              .setDescription(`${description}\n\n${confirmed ? "✅ **Confirmed.**" : "❌ **Cancelled.**"}`),
          ],
          components: [disabledRow],
        });
        log.debug("CONFIRM", "Confirmation message UI updated successfully.");
      } catch (error) {
        log.error("CONFIRM", "Failed to update confirmation message UI (decision already resolved, unaffected)", error);
      }
    });

    collector.on("end", async () => {
      if (settled) return; // already resolved by a real click above

      settled = true;
      log.info("CONFIRM", `"${title}" timed out with no response after ${CONFIRM_TIMEOUT_MS}ms — treating as cancelled.`);
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        confirmRow.components.map((b) => ButtonBuilder.from(b).setDisabled(true)),
      );

      await interaction
        .editReply({
          embeds: [baseEmbed().setTitle(title).setDescription(`${description}\n\n⌛ **Timed out — action cancelled.**`)],
          components: [disabledRow],
        })
        .catch((error) => log.error("CONFIRM", "Failed to update confirmation message after timeout", error));

      resolve(false);
    });
  });
}
