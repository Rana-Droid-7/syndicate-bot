import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { SyndicateClient } from "../core/client.js";
import type { ClientEvents } from "discord.js";
import { log } from "../core/logger.js";
import { sendDevLog } from "../lib/devlog.js";
import { baseEmbed } from "../lib/embeds.js";
import { errorDetail } from "../lib/safeError.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const eventsRoot = path.join(__dirname, "..", "events");

export interface BotEvent<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute: (...args: ClientEvents[K]) => Promise<void> | void;
}

export async function loadEvents(client: SyndicateClient): Promise<void> {
  const files = readdirSync(eventsRoot).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".js"),
  );
  log.debug("BOOT", `Found ${files.length} event file(s): ${files.join(", ")}`);

  for (const file of files) {
    const filePath = path.join(eventsRoot, file);
    const imported = await import(pathToFileURL(filePath).href);
    const event: BotEvent | undefined = imported.default;

    if (!event || !event.name || !event.execute) {
      log.warn("BOOT", `Skipping invalid event file: ${file}`);
      continue;
    }

    // Every event handler is wrapped uniformly here — individual
    // event files don't need their own try/catch. The wrapper logs
    // with sanitized detail (see lib/safeError.ts) so nothing
    // internal leaks into log channels.
    const wrapped = async (...args: unknown[]) => {
      try {
        log.debug("EVENT", `Firing "${String(event.name)}"...`);
        await event.execute(...(args as Parameters<typeof event.execute>));
        log.debug("EVENT", `"${String(event.name)}" completed.`);
      } catch (error) {
        log.error("EVENT", `Error in "${String(event.name)}" handler`, error);
        await sendDevLog(
          client,
          baseEmbed()
            .setTitle("⚠️ Event Handler Error")
            .addFields(
              { name: "Event", value: String(event.name), inline: true },
              { name: "Error", value: `\`\`\`${errorDetail(error)}\`\`\``, inline: false },
            ),
        ).catch((devlogError) => log.error("EVENT", "Failed to send devlog for event error", devlogError));
      }
    };

    if (event.once) {
      client.once(event.name, wrapped);
    } else {
      client.on(event.name, wrapped);
    }
    log.debug("BOOT", `Registered event listener "${String(event.name)}" (once=${!!event.once}) from ${file}`);
  }

  log.info("BOOT", `Loaded ${files.length} event handler(s).`);
}
