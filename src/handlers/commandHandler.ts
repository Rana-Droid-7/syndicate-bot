import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { SyndicateClient } from "../core/client.js";
import type { AnyCommand, Command } from "../types/command.js";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const commandsRoot = path.join(__dirname, "..", "commands");

// The surface policy: PUBLIC commands (utility, coolsies) live on the
// env prefix exclusively; PRIVILEGED commands (moderation, admin,
// owner) live on native slash exclusively — Discord's structured
// input and permission gating are part of their safety model.
const PREFIX_ONLY_CATEGORIES = new Set(["utility", "coolsies"]);
const SLASH_ONLY_CATEGORIES = new Set(["moderation", "admin", "owner"]);

/**
 * Walks src/commands/<category>/*.ts, imports each file's default
 * export as a Command and registers it.
 *
 * Development-time contract violations (duplicate names, missing
 * entrypoints for the declared surface, missing usage metadata) are
 * LOAD ERRORS — the process refuses to start rather than silently
 * degrading. A bot that quietly dropped a command is worse than a
 * bot that doesn't boot.
 *
 * Canonical name resolution:
 *  - prefix-only commands: explicit `name` ?? first prefixName
 *  - slash-only commands: data.name
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

      const cmd = command as Command;
      const hasSlash = typeof cmd.execute === "function";
      const hasPrefix = typeof cmd.prefixExecute === "function";
      const hasData = !!cmd.data;

      // Category must be one of the five known values — an out-of-enum
      // category sails through the surface checks below and then
      // crashes the help system's category lookup at runtime
      // (CATEGORY_META[category].emoji -> undefined). Reject at load.
      if (!PREFIX_ONLY_CATEGORIES.has(cmd.category) && !SLASH_ONLY_CATEGORIES.has(cmd.category)) {
        throw new Error(
          `Command in ${categoryDir.name}/${file} has unknown category "${cmd.category}" — ` +
            `valid categories: utility, coolsies, moderation, admin, owner.`,
        );
      }

      // ---- surface policy (v0.5.4): strict two-lane split ----
      if (PREFIX_ONLY_CATEGORIES.has(cmd.category)) {
        if (hasSlash || hasData) {
          throw new Error(
            `Command "${cmd.name ?? "?"}" (${categoryDir.name}/${file}) is in a public category — ` +
              `public commands are prefix-ONLY. Remove the slash builder (data) and execute().`,
          );
        }
        if (cmd.surface !== "prefix-only") {
          throw new Error(
            `Command "${cmd.name ?? "?"}" (${categoryDir.name}/${file}): public commands must declare surface "prefix-only" — slash is reserved for moderation/admin/developer.`,
          );
        }
      }
      if (SLASH_ONLY_CATEGORIES.has(cmd.category) && cmd.surface !== "slash-only") {
        throw new Error(
          `Command "${cmd.data?.name ?? "?"}" (${categoryDir.name}/${file}): privileged commands are slash-ONLY — they need Discord's structured input and native permission gating.`,
        );
      }

      if (!cmd.usage || typeof cmd.usage !== "string" || cmd.usage.length === 0) {
        throw new Error(`Command in ${categoryDir.name}/${file} is missing its "usage" metadata.`);
      }
      if (!cmd.description || typeof cmd.description !== "string" || cmd.description.length === 0) {
        throw new Error(`Command in ${categoryDir.name}/${file} is missing its "description" metadata.`);
      }
      if (cmd.description.length > 100) {
        throw new Error(
          `Command "${cmd.data?.name ?? "?"}" (${categoryDir.name}/${file}): description must be a one-liner under 100 chars — put the long story in "details".`,
        );
      }
      // Usage/examples must be prefix-FREE: every display site
      // renders them with the env prefix, so PREFIX=! in .env
      // flips the whole help system at once. Slash usage lines
      // ("/kick ...") are fine as-is — they're literal command names.
      if (cmd.surface === "prefix-only") {
        if (cmd.usage.startsWith(config.prefix)) {
          throw new Error(
            `Command "${cmd.name ?? "?"}" (${categoryDir.name}/${file}): usage must be prefix-free ("${cmd.usage.replace(config.prefix, "")}") — the help system renders the env prefix itself.`,
          );
        }
        if (cmd.examples?.some((e) => e.startsWith(config.prefix))) {
          throw new Error(
            `Command "${cmd.name ?? "?"}" (${categoryDir.name}/${file}): examples must be prefix-free — the help system renders the env prefix itself.`,
          );
        }
      }
      if (!cmd.surface) {
        throw new Error(`Command in ${categoryDir.name}/${file} is missing its "surface" metadata.`);
      }
      if (cmd.surface === "slash-only" && (!hasSlash || !hasData)) {
        throw new Error(
          `Command "${cmd.data?.name ?? "?"}" (${categoryDir.name}/${file}) declares surface "${cmd.surface}" but lacks execute() or data.`,
        );
      }
      if (cmd.surface === "prefix-only" && !hasPrefix) {
        throw new Error(
          `Command "${cmd.name ?? "?"}" (${categoryDir.name}/${file}) declares surface "${cmd.surface}" but has no prefixExecute().`,
        );
      }
      if (cmd.surface === "prefix-only" && hasSlash) {
        throw new Error(
          `Command "${cmd.name}" (${categoryDir.name}/${file}) is prefix-only but defines execute() — remove it or change the surface.`,
        );
      }

      // ---- canonical name ----
      let name: string;
      if (cmd.data) {
        const dataName = cmd.data.name;
        if (!dataName) {
          throw new Error(`Command in ${categoryDir.name}/${file} has no data.name — prefix-only commands need "name" or "prefixNames".`);
        }
        name = dataName;
      } else {
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
        `Registered command ${name} (category: ${command.category}, surface: ${cmd.surface}) from ${categoryDir.name}/${file}`,
      );

      // ---- prefix registration ----
      if (cmd.surface === "slash-only") {
        client.slashOnlyCommands.add(name);
      } else {
        const names = new Set<string>([name, ...(cmd.prefixNames ?? [])]);
        // The dispatch lookups lowercase the user's input, so a
        // mixed-case alias can never be typed reachably — reject it
        // at load rather than shipping a dead alias. (The canonical
        // name of a slash command is Discord's concern; djs enforces
        // its own lowercase rule there.)
        for (const alias of names) {
          if (alias !== alias.toLowerCase()) {
            throw new Error(
              `Prefix alias "${alias}" (command ${name}, ${categoryDir.name}/${file}) must be lowercase — ` +
                `dispatch lowercases the input before lookup, so a mixed-case alias is unreachable.`,
            );
          }
          if (client.prefixCommands.has(alias)) {
            throw new Error(
              `Duplicate prefix alias "${alias}" (command ${name}, ${categoryDir.name}/${file}) — already registered. Load-time error by design.`,
            );
          }
          client.prefixCommands.set(alias, cmd);
        }
        log.debug("BOOT", `Registered prefix alias(es) for ${name}: ${[...names].join(", ")}`);
      }

      loaded++;
    }
  }

  // ---- flatten suggestion candidates AFTER everything is loaded ----
  client.suggestionCandidates = [...client.slashCommands.values()]
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
