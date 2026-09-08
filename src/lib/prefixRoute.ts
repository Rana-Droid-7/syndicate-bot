import type { SyndicateClient } from "../core/client.js";
import { config } from "../core/config.js";
import type { Command } from "../types/command.js";
import type { SuggestionCandidate, StartsWithMatch } from "./suggest.js";
import { findClosestMatch, findStartsWithMatches, MIN_SUGGESTION_LENGTH } from "./suggest.js";

/**
 * Who is looking at a command list — the admin/developer gates that
 * decide which categories are VISIBLE (suggestions, help, lookups).
 * One shared shape for both dispatch surfaces.
 */
export interface Viewer {
  userId: string;
  isAdminHere: boolean;
}

/**
 * Visible suggestion candidates for this viewer (admin/owner
 * filtered). THE single implementation — the dispatcher's lookup
 * lane, `>help`'s unknown-command page, and the verify harnesses all
 * consumed their own copies before, and a visibility rule tightened
 * in one but not the other leaks privileged commands through the
 * stale path (the exact drift class this codebase refuses).
 */
export function visibleCandidatesFor(client: SyndicateClient, viewer: Viewer): SuggestionCandidate[] {
  const isDev = config.developerIds.includes(viewer.userId);
  return client.suggestionCandidates.filter((c) => {
    if (c.command.category === "admin") return viewer.isAdminHere;
    if (c.command.category === "owner") return isDev;
    return true;
  });
}

/** The dispatch decision for an unknown prefix input. */
export type PrefixRoute =
  | { kind: "known"; commandName: string }
  | { kind: "slash-only"; commandName: string }
  | { kind: "lookup"; commandName: string; matches: StartsWithMatch[] }
  | { kind: "typo"; commandName: string; suggestion: Command }
  | { kind: "ignore" };

/**
 * Routes one lowercased command token: the pure decision core of the
 * prefix dispatcher. Extracted so the dispatch edge-case harness
 * tests THE REAL logic instead of a re-implementation that can drift
 * (the failure mode verify_lookup.mjs was rewritten to kill: a
 * hand-maintained fixture passing all its checks while describing a
 * fantasy). The event handler owns all I/O — replies, logging,
 * cooldowns; this function only decides.
 */
export function routePrefixCommand(
  client: SyndicateClient,
  commandName: string,
  viewer: Viewer,
): PrefixRoute {
  // A command we know: dispatch it.
  if (client.prefixCommands.has(commandName)) {
    return { kind: "known", commandName };
  }
  // A slash-only command's name typed with the prefix: explain it.
  if (client.slashOnlyCommands.has(commandName)) {
    return { kind: "slash-only", commandName };
  }
  // The suggestion lanes only make sense for sane alphanumeric input
  // — anything else is prose that happened to start with ">".
  if (commandName.length <= 20 && /^[a-z0-9]+$/i.test(commandName)) {
    const candidates = visibleCandidatesFor(client, viewer);
    const startsWith = findStartsWithMatches(candidates, commandName);
    if (startsWith.length > 0) {
      return { kind: "lookup", commandName, matches: startsWith };
    }
    if (commandName.length >= MIN_SUGGESTION_LENGTH) {
      const suggestion = findClosestMatch(candidates, commandName);
      if (suggestion) {
        return { kind: "typo", commandName, suggestion };
      }
    }
  }
  return { kind: "ignore" };
}
