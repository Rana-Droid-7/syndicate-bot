import { ApplicationCommandOptionType } from "discord.js";
import type { Command } from "../types/command.js";

interface RawOption {
  name: string;
  required?: boolean;
  type: ApplicationCommandOptionType;
  options?: RawOption[];
}

function formatOption(opt: RawOption): string {
  return opt.required ? `<${opt.name}>` : `[${opt.name}]`;
}

/**
 * Builds a usage string (or, for subcommand-based commands, one
 * line per subcommand) directly from a command's own slash builder.
 * This is generated, not hand-written, so it can never drift out
 * of sync with what the command actually accepts. Handles plain
 * options, subcommands, and subcommand groups (each subcommand
 * inside a group gets its own line: /cmd group sub <opts>).
 */
export function buildUsageLines(cmd: Command): string[] {
  // Prefix-only commands carry their usage in metadata, not a builder.
  if (!cmd.data) return [cmd.usage];
  const json = cmd.data.toJSON() as { name: string; options?: RawOption[] };
  const options = json.options ?? [];

  const subcommands = options.filter((o) => o.type === ApplicationCommandOptionType.Subcommand);

  if (subcommands.length > 0) {
    return subcommands.map((sub) => {
      const subOptions = (sub.options ?? []).map(formatOption).join(" ");
      return `/${json.name} ${sub.name}${subOptions ? " " + subOptions : ""}`.trim();
    });
  }

  const groups = options.filter((o) => o.type === ApplicationCommandOptionType.SubcommandGroup);
  if (groups.length > 0) {
    const lines: string[] = [];
    for (const group of groups) {
      for (const sub of group.options ?? []) {
        if (sub.type !== ApplicationCommandOptionType.Subcommand) continue;
        const subOptions = (sub.options ?? []).map(formatOption).join(" ");
        lines.push(`/${json.name} ${group.name} ${sub.name}${subOptions ? " " + subOptions : ""}`.trim());
      }
    }
    if (lines.length > 0) return lines;
  }

  const regularOptions = options.filter((o) => o.type !== ApplicationCommandOptionType.SubcommandGroup);
  const optsStr = regularOptions.map(formatOption).join(" ");
  return [`/${json.name}${optsStr ? " " + optsStr : ""}`.trim()];
}
