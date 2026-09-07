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

  let registered = 0;
  for (const file of files) {
    const filePath = path.join(eventsRoot, file);
    const imported = await import(pathToFileURL(filePath).href);
    const event: BotEvent | undefined = imported.default;

    // Structural invalidity is a BOOT ERROR, same philosophy as the
    // command loader: "a bot that quietly dropped a command is worse
    // than a bot that doesn't boot" — and a silently-skipped
    // messageCreate means the entire prefix lane is dead with only a
    // warn line anyone could miss. This directory is a fixed, curated
    // set; there is no legitimate "optional" event file.
    if (!event || !event.name || !event.execute) {
      throw new Error(
        `Event file ${file} is structurally invalid (missing name/execute) — refusing to boot. ` +
          `Fix the file or remove it; a silently skipped event handler would disable part of the bot.`,
      );
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
    registered++;
    log.debug("BOOT", `Registered event listener "${String(event.name)}" (once=${!!event.once}) from ${file}`);
  }

  // Counts REGISTERED handlers, not files — a boot that registered
  // fewer listeners than it found files is now impossible (invalid
  // files throw), but the count should still never overstate.
  log.info("BOOT", `Loaded ${registered} event handler(s).`);
}
