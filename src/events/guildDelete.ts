import type { Guild } from "discord.js";
import type { BotEvent } from "../handlers/eventHandler.js";
import { baseEmbed } from "../lib/embeds.js";
import { sendDevLog } from "../lib/devlog.js";
import { guildRepository } from "../repositories/guilds.js";
import { pruneOrphanedUsers } from "../repositories/shared.js";
import { afkService } from "../services/afk.js";
import { log } from "../core/logger.js";

const event: BotEvent<"guildDelete"> = {
  name: "guildDelete",
  async execute(guild: Guild) {
    log.info("EVENT", `Left guild "${guild.name}" (${guild.id}) — cleaning up its data.`);

    // Clean the departing guild's data. Deleting the guild row cascades
    // to afk/reminders/warnings/suggestions (all FK ON DELETE CASCADE);
    // in-memory reminder timers for it fail their delivery gracefully
    // (channel is gone anyway).
    let removed = 0;
    let prunedUsers = 0;
    // The in-memory AFK index drops FIRST: it's pure memory cleanup and
    // must never be skipped because a later DB step threw.
    afkService.dropGuildIndex(guild.id);
    try {
      removed = guildRepository.remove(guild.id);
      // The cascades orphan the departed guild's `users` rows (nothing
      // references them anymore) — sweep those too so the table
      // doesn't grow without bound across months of joins/leaves.
      prunedUsers = pruneOrphanedUsers();
    } catch (error) {
      log.error("EVENT", `Failed to clean data for guild ${guild.id}`, error);
    }

    log.info(
      "EVENT",
      `Cleanup for guild ${guild.id}: ${removed > 0 ? "guild row + cascades removed" : "no data existed"}${prunedUsers > 0 ? `, ${prunedUsers} orphaned user row(s) pruned` : ""}.`,
    );

    await sendDevLog(
      guild.client,
      baseEmbed()
        .setTitle("📤 Left a Server")
        .addFields(
          { name: "Server", value: `${guild.name} (\`${guild.id}\`)`, inline: false },
          { name: "Total Servers", value: `${guild.client.guilds.cache.size}`, inline: true },
        ),
    );
  },
};

export default event;
