import type { Guild } from "discord.js";
import type { BotEvent } from "../handlers/eventHandler.js";
import { baseEmbed } from "../lib/embeds.js";
import { sendDevLog } from "../lib/devlog.js";
import { log } from "../core/logger.js";

const event: BotEvent<"guildCreate"> = {
  name: "guildCreate",
  async execute(guild: Guild) {
    log.info("EVENT", `Joined guild "${guild.name}" (${guild.id}) — ${guild.memberCount} members, owner ${guild.ownerId}.`);

    await sendDevLog(
      guild.client,
      baseEmbed()
        .setTitle("📥 Joined a Server")
        .addFields(
          { name: "Server", value: `${guild.name} (\`${guild.id}\`)`, inline: false },
          { name: "Members", value: `${guild.memberCount}`, inline: true },
          { name: "Total Servers", value: `${guild.client.guilds.cache.size}`, inline: true },
        ),
    );
  },
};

export default event;
