import type { Command } from "../types/command.js";
import { config } from "../core/config.js";

// How many single-character edits a "typo" may be away from a real
// command before we stop suggesting it.
export const MAX_SUGGESTION_DISTANCE = 2;
// Very short inputs suggest too eagerly ("a" -> "h" via edit
// distance is noise, not help). Starts-with matching has no minimum
// — it's precise — but typo GUESSING needs at least 3 characters.
export const MIN_SUGGESTION_LENGTH = 3;
// Cap on how many starts-with matches get listed in one embed.
export const MAX_LOOKUP_RESULTS = 15;
// Stay under Discord's 4096-char embed description limit with margin.
const LOOKUP_CHAR_BUDGET = 4000;

/** Classic Levenshtein edit distance, early-exit at max+1. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1; // this row can't produce <= max anymore
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * One visible command, pre-flattened for matching: the canonical
 * slash name plus every prefix alias. Callers build this list with
 * the viewer's visibility already applied (admin/owner categories
 * filtered out for people who can't use them), so the matchers
 * here never leak hidden commands.
 */
export interface SuggestionCandidate {
  command: Command;
  names: string[];
}

export interface StartsWithMatch {
  command: Command;
  /** The names (canonical or alias) that start with the input. */
  matched: string[];
}

/**
 * Every visible command whose canonical name OR a prefix alias
 * starts with `input` (tier 1), plus commands whose names merely
 * CONTAIN the input as a substring (tier 2 — so ">se" also surfaces
 * /suggest, which doesn't start with "se"). Starts-with matches
 * sort first, everything alphabetically within tiers.
 */
export function findStartsWithMatches(candidates: SuggestionCandidate[], input: string): StartsWithMatch[] {
  const startsWith: StartsWithMatch[] = [];
  const containsOnly: StartsWithMatch[] = [];

  for (const candidate of candidates) {
    const leading = candidate.names.filter((n) => n.startsWith(input));
    if (leading.length > 0) {
      startsWith.push({ command: candidate.command, matched: leading });
      continue;
    }
    const containing = candidate.names.filter((n) => n.includes(input));
    if (containing.length > 0) {
      containsOnly.push({ command: candidate.command, matched: containing });
    }
  }

  const byName = (x: StartsWithMatch, y: StartsWithMatch) =>
    (x.command.name ?? x.command.data?.name ?? "").localeCompare(y.command.name ?? y.command.data?.name ?? "");
  startsWith.sort(byName);
  containsOnly.sort(byName);

  return [...startsWith, ...containsOnly];
}

/**
 * The closest visible command by edit distance across all names
 * (canonical + aliases). Ties prefer the name closest in LENGTH to
 * the input — "punrg" (5) tying between "ping" (4) and "purge" (5)
 * should pick "purge", since the lengths lining up usually means
 * more of the input actually matched. Powers the ">halp" -> "/help"
 * typo reply.
 */
export function findClosestMatch(candidates: SuggestionCandidate[], input: string): Command | null {
  let best: Command | null = null;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  let bestName = "";

  for (const candidate of candidates) {
    for (const name of candidate.names) {
      const distance = editDistance(input, name, MAX_SUGGESTION_DISTANCE);
      if (distance < bestDistance) {
        best = candidate.command;
        bestDistance = distance;
        bestName = name;
      } else if (distance === bestDistance && best) {
        // Tie: prefer the name whose length is closest to the input.
        if (Math.abs(name.length - input.length) < Math.abs(bestName.length - input.length)) {
          best = candidate.command;
          bestName = name;
        }
      }
    }
  }
  return best;
}

/** One compact lookup line: bullet, bold name, usage, surface note. */
function formatMatchLine(match: StartsWithMatch): string {
  const cmd = match.command;
  const name = cmd.name ?? cmd.data?.name ?? "unknown";
  const isSlash = cmd.surface === "slash-only";
  // Prefix commands store usage prefix-free; render with the env prefix.
  const usage = isSlash ? cmd.usage : `${config.prefix}${cmd.usage}`;
  const surfaceNote = isSlash ? "slash-only" : `\`${config.prefix}${name}\``;

  const badge = isSlash ? `**/${name}**` : `**${config.prefix}${name}**`;
  return `• ${badge} \`${usage}\` · ${surfaceNote}`;
}

export interface LookupDescription {
  description: string;
  shown: number;
  total: number;
}

/**
 * Formats the starts-with match list for an embed description,
 * capped at MAX_LOOKUP_RESULTS entries and the char budget. If
 * anything is cut, an "…and N more" line is appended.
 */
export function formatLookupDescription(matches: StartsWithMatch[]): LookupDescription {
  const total = matches.length;
  const lines: string[] = [];
  let shown = 0;
  let size = 0;

  for (const match of matches) {
    if (shown >= MAX_LOOKUP_RESULTS) break;
    const line = formatMatchLine(match);
    if (shown > 0 && size + line.length + 1 > LOOKUP_CHAR_BUDGET) break;
    lines.push(line);
    size += line.length + 1;
    shown++;
  }

  const extra = total - shown;
  if (extra > 0) lines.push(`_…and ${extra} more — run \`/help\` to browse everything._`);

  return { description: lines.join("\n"), shown, total };
}
