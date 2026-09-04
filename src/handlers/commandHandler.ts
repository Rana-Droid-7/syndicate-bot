import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { SyndicateClient } from "../core/client.js";
import type { AnyCommand, Command } from "../types/command.js";
import { log } from "../core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsRoot = path.join(__dirname, "..", "commands");

/**
 * Walks src/commands/<category>/*.ts, imports each file's default
 * export as a Command (or UserContextCommand), and registers it.
 *
 * Development-time contract violations (duplicate names, missing
 * entrypoints for the declared surface, missing usage metadata) are
 * LOAD ERRORS — the process refuses to start rather than silently
 * degrading. A bot that quietly dropped a command is worse than a
 * bot that doesn't boot.
 *
 * Canonical name resolution:
 *  - slash/context commands: data.name
 *  - prefix-only commands: explicit `name` ?? first prefixName
 */
export async function loadCommands(client: SyndicateClient): Promise<void> {
  const categories = readdirSync(commandsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  log.debug("BOOT", `Found ${categories.length} command categories: ${categories.map((c) => c.name).join(", ")}`);

  let loaded = 0;

  for (const categoryDir of categories) {
    const categoryPath = path.join(commandsRoot, categoryDir.name);
    const files = readdirSync(categoryPath).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    log.debug("BOOT", `Category "${categoryDir.name}": ${files.length} file(s) found.`);

    for (const file of files) {
      const filePath = path.join(categoryPath, file);
      const imported = await import(pathToFileURL(filePath).href);
      const command: AnyCommand | undefined = imported.default;

      if (!command || !command.category) {
        log.debug("BOOT", `Skipping non-command file: ${categoryDir.name}/${file}`);
        continue;
      }

      const isContext = "contextMenu" in command;

      if (!isContext) {
        const cmd = command as Command;
        const hasSlash = typeof cmd.execute === "function";
        const hasPrefix = typeof cmd.prefixExecute === "function";
        const hasData = !!cmd.data;

        if (!cmd.usage || typeof cmd.usage !== "string" || cmd.usage.length === 0) {
          throw new Error(`Command in ${categoryDir.name}/${file} is missing its "usage" metadata.`);
        }
        if (!cmd.surface) {
          throw new Error(`Command in ${categoryDir.name}/${file} is missing its "surface" metadata.`);
        }
        if ((cmd.surface === "slash-only" || cmd.surface === "both") && (!hasSlash || !hasData)) {
          throw new Error(
            `Command "${cmd.data?.name ?? "?"}" (${categoryDir.name}/${file}) declares surface "${cmd.surface}" but lacks execute() or data.`,
          );
        }
        if ((cmd.surface === "prefix-only" || cmd.surface === "both") && !hasPrefix) {
          throw new Error(
            `Command "${cmd.name ?? "?"}" (${categoryDir.name}/${file}) declares surface "${cmd.surface}" but has no prefixExecute().`,
          );
        }
        if (cmd.surface === "prefix-only" && hasSlash) {
          throw new Error(
            `Command "${cmd.name}" (${categoryDir.name}/${file}) is prefix-only but defines execute() — remove it or change the surface.`,
          );
        }
      }

      // ---- canonical name ----
      let name: string;
      if (isContext || (command as Command).data) {
        const dataName = command.data?.name;
        if (!dataName) {
          throw new Error(`Command in ${categoryDir.name}/${file} has no data.name — prefix-only commands need "name" or "prefixNames".`);
        }
        name = dataName;
      } else {
        const cmd = command as Command;
        name = cmd.name ?? cmd.prefixNames?.[0] ?? "";
        if (!name) {
          throw new Error(`Prefix-only command in ${categoryDir.name}/${file} needs a "name" or "prefixNames".`);
        }
      }

      // ---- duplicate registration: hard error ----
      if (client.slashCommands.has(name)) {
        throw new Error(
          `Duplicate command name "${name}" in ${categoryDir.name}/${file} — already loaded from another file. Rename one. Load-time error by design.`,
        );
      }
      client.slashCommands.set(name, command);
      log.debug(
        "BOOT",
        `Registered command ${name} (category: ${command.category}, surface: ${isContext ? "context-menu" : (command as Command).surface}) from ${categoryDir.name}/${file}`,
      );

      // ---- prefix registration (commands only) ----
      if (!isContext) {
        const cmd = command as Command & { name: string };
        if (cmd.surface === "slash-only") {
          client.slashOnlyCommands.add(name);
        } else {
          const names = new Set<string>([name, ...(cmd.prefixNames ?? [])]);
          for (const alias of names) {
            if (client.prefixCommands.has(alias)) {
              throw new Error(
                `Duplicate prefix alias "${alias}" (command ${name}, ${categoryDir.name}/${file}) — already registered. Load-time error by design.`,
              );
            }
            client.prefixCommands.set(alias, cmd);
          }
          log.debug("BOOT", `Registered prefix alias(es) for ${name}: ${[...names].join(", ")}`);
        }
      }

      loaded++;
    }
  }

  // ---- flatten suggestion candidates AFTER everything is loaded ----
  client.suggestionCandidates = [...client.slashCommands.values()]
    .filter((c): c is Command => !("contextMenu" in c))
    .map((command) => {
      const names = new Set<string>([command.name ?? command.data?.name ?? ""]);
      if (command.surface !== "slash-only" && command.prefixExecute) {
        for (const alias of command.prefixNames ?? [command.name ?? command.data?.name ?? ""]) names.add(alias);
      }
      names.delete("");
      return { command, names: [...names] };
    });

  log.info("BOOT", `Loaded ${loaded} command(s) total across ${categories.length} categories.`);
}
