import type { Guild } from "discord.js";
import type { BotEvent } from "../handlers/eventHandler.js";
import { baseEmbed } from "../lib/embeds.js";
import { sendDevLog } from "../lib/devlog.js";
import { guildRepository } from "../repositories/guilds.js";
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
    try {
      removed = guildRepository.remove(guild.id);
      // The in-memory AFK index must not keep stale members of a gone
      // guild — a re-join + immediate mention must not hit the notice
      // path with no backing row.
      afkService.dropGuildIndex(guild.id);
    } catch (error) {
      log.error("EVENT", `Failed to clean data for guild ${guild.id}`, error);
    }

    log.info("EVENT", `Cleanup for guild ${guild.id}: ${removed > 0 ? "guild row + cascades removed" : "no data existed"}.`);

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
