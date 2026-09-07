import { REST, Routes } from "discord.js";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { config } from "./core/config.js";
import type { AnyCommand } from "./types/command.js";
import { log } from "./core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsRoot = path.join(__dirname, "commands");

async function main() {
  log.info("DEPLOY", `Scanning ${commandsRoot} for commands...`);
  const commandData = [];
  const seenNames = new Map<string, string>(); // name -> originating file, for duplicate reporting
  const categories = readdirSync(commandsRoot, { withFileTypes: true }).filter((d) =>
    d.isDirectory(),
  );

  for (const categoryDir of categories) {
    const categoryPath = path.join(commandsRoot, categoryDir.name);
    const files = readdirSync(categoryPath).filter(
      (f) => f.endsWith(".ts") || f.endsWith(".js"),
    );

    for (const file of files) {
      const filePath = path.join(categoryPath, file);
      const imported = await import(pathToFileURL(filePath).href);
      const command: AnyCommand | undefined = imported.default;
      // Prefix-only commands have no slash builder — they never deploy.
      if (command?.data) {
        // v0.5.4 policy: slash deployment is for moderation/admin/
        // owner ONLY. A public command with a slash builder would ship
        // it to a surface the runtime loader rejects at boot —
        // refuse here with the exact reason instead.
        const category = command.category;
        if (category === "utility" || category === "coolsies") {
          throw new Error(
            `Refusing to deploy /${command.data.name} (${categoryDir.name}/${file}): public commands are ` +
              `prefix-ONLY (the env prefix). Slash is reserved for moderation, admin, and developer commands.`,
          );
        }
        // Surface/entrypoint parity with the runtime loader: a
        // privileged command with a slash builder but a wrong surface
        // or a missing execute() would DEPLOY successfully and then
        // make the bot refuse to boot (or dispatch "doesn't run").
        // Deploy-time must catch everything boot-time catches.
        if (command.surface !== "slash-only") {
          throw new Error(
            `Refusing to deploy /${command.data.name} (${categoryDir.name}/${file}): category "${category}" commands must declare surface "slash-only" — the runtime loader enforces the same at boot.`,
          );
        }
        if (typeof command.execute !== "function") {
          throw new Error(
            `Refusing to deploy /${command.data.name} (${categoryDir.name}/${file}): it has a slash builder but no execute() — it would register in Discord but never run.`,
          );
        }
        // Duplicate command names make Discord's bulk PUT fail with a
        // cryptic REST error AFTER the whole payload is sent — catch
        // it locally instead, with the offending files named.
        const name = command.data.name;
        const previous = seenNames.get(name);
        if (previous) {
          throw new Error(
            `Duplicate command name "/${name}": defined in both ${previous} and ${categoryDir.name}/${file}. ` +
              `Rename one of them before deploying.`,
          );
        }
        seenNames.set(name, `${categoryDir.name}/${file}`);
        commandData.push(command.data.toJSON());
        log.debug("DEPLOY", `Queued /${name} (${categoryDir.name}/${file}) for registration.`);
      }
    }
  }

  const rest = new REST().setToken(config.token);

  log.info("DEPLOY", `Registering ${commandData.length} slash command(s)...`);

  if (config.devGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.devGuildId),
      { body: commandData },
    );
    log.info("DEPLOY", `Registered to dev guild ${config.devGuildId}.`);
    // Clear the GLOBAL registration too: switching an env from global
    // to dev-guild mode previously left the old global commands live
    // for up to an hour, replying "unknown command" to every use —
    // a stale surface with no runtime behind it.
    await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
    log.info("DEPLOY", "Cleared global registration (dev-guild mode — was possibly stale from an earlier global deploy).");
  } else {
    await rest.put(Routes.applicationCommands(config.clientId), { body: commandData });
    log.info("DEPLOY", "Registered globally (may take up to 1 hour to appear).");
  }
}

main().catch((error) => {
  log.error("DEPLOY", "Failed to register commands", error);
  process.exit(1);
});
