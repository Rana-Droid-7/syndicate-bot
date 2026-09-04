import { ActivityType, type Client } from "discord.js";
import type { BotEvent } from "../handlers/eventHandler.js";
import { config } from "../core/config.js";
import type { SyndicateClient } from "../core/client.js";
import { announceOnline } from "../lib/devlog.js";
import { log } from "../core/logger.js";

const event: BotEvent<"clientReady"> = {
  name: "clientReady",
  once: true,
  async execute(client: Client<true>) {
    (client as SyndicateClient).startTime = Date.now();

    log.info("BOOT", `${config.botName} v${config.version} logged in as ${client.user.tag} (${client.user.id})`);
    log.info("BOOT", `Serving ${client.guilds.cache.size} guild(s): ${client.guilds.cache.map((g) => g.name).join(", ")}`);
    log.info("BOOT", `Total member count across all guilds (approx.): ${client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0)}`);

    client.user.setPresence({
      activities: [
        {
          name: `v${config.version} | ${config.prefix}help`,
          type: ActivityType.Watching,
        },
      ],
      status: "online",
    });
    log.debug("BOOT", "Presence/activity set.");
    log.info("BOOT", "Bot is fully ready and listening for commands.");

    // Announce "online" to the dev-log channel so every startup is
    // visible there (pairs with announceOffline on every shutdown
    // path: signal, crash, and /boot panel actions).
    await announceOnline(client);
  },
};

export default event;
