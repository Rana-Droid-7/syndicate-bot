/**
 * Extensive tests for the prefix lookup system (lib/suggest.ts).
 * Run: node verify_lookup.mjs   (requires `npm run build` first)
 *
 * The candidate set is derived from the REAL loaded command registry
 * (loadCommands on a real SyndicateClient) — never a hand-maintained
 * fixture. Cycle 6 of the audit caught the previous hand-list
 * drifting from reality: it claimed `roll` had a `dice` alias
 * (dice is its own command), listed `poll` as slash-only (prefix
 * since v0.5.4), and predated every Coolsies command — and all its
 * tests still passed, because it only tested its own fantasy.
 *
 * Tests the exact user-facing scenarios plus edge cases:
 *   ">a"  -> lists every command starting with "a", each with usage
 *   ">se" -> lists serverinfo, setnick, suggest ... with usage
 *   ">halp" -> typo suggestion for /help with usage
 *   visibility, caps, digits, boundaries, caps, empty results...
 */

import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, "data", "lookup-test.db");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
process.env.DATABASE_FILE = "data/lookup-test.db";
process.env.DISCORD_TOKEN = "x";
process.env.CLIENT_ID = "123456789012345678";

await import("./dist/database/client.js").then((m) => m.runMigrations());
const { loadCommands } = await import("./dist/handlers/commandHandler.js");
const { SyndicateClient } = await import("./dist/core/client.js");
const realClient = new SyndicateClient({ intents: [] });
await loadCommands(realClient);

const { findStartsWithMatches, findClosestMatch, formatLookupDescription, editDistance, MAX_SUGGESTION_DISTANCE } =
  await import("./dist/lib/suggest.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  // Promise.resolve().then(fn) supports both sync and async test fns.
  return Promise.resolve()
    .then(fn)
    .then(
      () => { passed++; console.log(`✅ PASS  ${name}`); },
      (err) => { failed++; console.error(`❌ FAIL  ${name}: ${err.message}`); },
    );
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// The candidate set IS the live registry — the same list the real
// dispatcher matches against (client.suggestionCandidates is built by
// the loader from every loaded command's canonical name + aliases).
const cands = realClient.suggestionCandidates;

// Sanity pins: the registry must contain the commands the scenario
// assertions below reference. If a rename ever breaks a scenario,
// these fail FIRST with a precise message instead of a cryptic miss.
await test("registry: expected commands are loaded", () => {
  const names = cands.map((c) => c.command.name ?? c.command.data?.name);
  for (const expected of ["help", "afk", "avatar", "announce", "setnick", "serverinfo",
    "userinfo", "suggest", "bot", "boot", "purge", "changelog", "calculate", "poll",
    "dice", "joke", "8ball", "rps"]) {
    assert(names.includes(expected), `command "${expected}" missing from the loaded registry`);
  }
});

// --- editDistance basics ---
await test("editDistance: identical", () => {
  assert(editDistance("help", "help", 2) === 0, "identical should be 0");
});
await test("editDistance: one insertion", () => {
  assert(editDistance("halp", "help", 2) === 1, "halp-help should be 1");
});
await test("editDistance: far pairs early-exit", () => {
  assert(editDistance("xyzzy", "help", 2) > 2, "far pair should exceed max");
});

// --- starts-with lookups: the two headline scenarios ---
await test(">a lists every command starting with 'a' (avatar via alias av? no — starts-with)", () => {
  const m = findStartsWithMatches(cands, "a");
  const names = m.map((x) => x.command.name ?? x.command.data?.name);
  assert(names.includes("avatar"), `avatar missing from ${names}`);
  assert(names.includes("afk"), `afk missing from ${names}`);
  assert(names.includes("announce"), `announce missing from ${names}`);
  // alias 'about' starts with a -> bot included too
  assert(names.includes("bot"), "bot (alias 'about') should match via alias");
});

await test(">se lists serverinfo + setnick (starts-with) and userinfo (contains)", () => {
  const m = findStartsWithMatches(cands, "se");
  const names = m.map((x) => x.command.name ?? x.command.data?.name);
  assert(names.includes("serverinfo"), "serverinfo missing");
  assert(names.includes("setnick"), "setnick missing");
  assert(names.includes("userinfo"), "userinfo missing (contains 'se')");
  // suggest is s-u-g-g-e-s-t: no 'se' anywhere — correctly absent
  assert(!names.includes("suggest"), "suggest should NOT match 'se'");
});

await test("starts-with matches sorted alphabetically within tiers (tier 1 first)", () => {
  const m = findStartsWithMatches(cands, "s");
  const names = m.map((x) => x.command.name ?? x.command.data?.name);
  // Tier 1 (starts-with): serverinfo, setnick, slowmode, snowflake, suggest
  // Tier 2 (contains):    changelog (alias 'changes'), help (alias... no wait, 'suggestion' alias of suggest)
  const tier1 = ["serverinfo", "setnick", "slowmode", "snowflake", "suggest"];
  for (const n of tier1) assert(names.includes(n), `tier1 missing ${n}`);
  assert(names.indexOf("serverinfo") < names.indexOf("suggest"), "tier1 not alphabetical");
  // everything after tier 1 is contains-tier
  const containsTier = names.slice(tier1.length);
  assert(!containsTier.includes("serverinfo"), "tier separation broken");
});

await test("starts-with via alias ('gu' -> serverinfo via guildinfo)", () => {
  const m = findStartsWithMatches(cands, "gu");
  assert(m.length === 1 && (m[0].command.name ?? m[0].command.data?.name) === "serverinfo", `expected serverinfo, got ${m.map((x) => x.command.name ?? x.command.data?.name)}`);
});

await test("starts-with: full name still matches (exact 'help')", () => {
  const m = findStartsWithMatches(cands, "help");
  assert(m.length === 1 && (m[0].command.name ?? m[0].command.data?.name) === "help", `expected [help], got ${m.map((x) => x.command.name ?? x.command.data?.name)}`);
});

await test("starts-with: no match returns empty", () => {
  const m = findStartsWithMatches(cands, "zzz");
  assert(m.length === 0, `expected empty, got ${m.length}`);
});

// --- visibility is caller's job, but confirm filtering works ---
await test("admin/owner commands excluded when caller filters candidates", () => {
  const filtered = cands.filter((c) => !["announce", "setnick", "slowmode", "boot", "kick", "ban", "timeout", "warn", "purge", "poll"].includes(c.command.name ?? c.command.data?.name));
  const m = findStartsWithMatches(filtered, "se");
  const names = m.map((x) => x.command.name ?? x.command.data?.name);
  assert(!names.includes("setnick"), "setnick should be filtered out");
  assert(names.includes("serverinfo"), "serverinfo should remain");
});

// --- formatLookupDescription ---
await test("lookup description lists matches with usage", () => {
  const m = findStartsWithMatches(cands, "se");
  const out = formatLookupDescription(m);
  assert(out.shown === m.length, "all shown");
  assert(out.total === m.length, "total matches");
  assert(out.description.includes("serverinfo"), "serverinfo usage (prefix-free) in description");
  assert(out.description.includes("slash-only"), "slash-only note present for setnick");
  assert(out.description.includes("`>serverinfo`"), "env-prefix badge present for serverinfo");
});

await test("lookup description caps at 15 entries with 'and N more'", () => {
  // 'a' matches many; force overflow with a big candidate set
  const many = Array.from({ length: 30 }, (_, i) => ({
    command: { name: "a" + i, category: "utility", usage: `>a${i}`, surface: "prefix-only", prefixExecute: async () => {} },
    names: ["a" + i],
  }));
  const m = findStartsWithMatches(many, "a");
  const out = formatLookupDescription(m);
  assert(out.total === 30, `total should be 30, got ${out.total}`);
  assert(out.shown === 15, `shown should cap at 15, got ${out.shown}`);
  assert(out.description.includes("and 15 more"), "overflow note missing");
});

await test("lookup description stays under 4096 chars", () => {
  const m = findStartsWithMatches(cands, "a");
  const out = formatLookupDescription(m);
  assert(out.description.length <= 4096, `description too long: ${out.description.length}`);
});

// --- typo suggestions ---
await test("typo: 'halp' -> help", () => {
  const s = findClosestMatch(cands, "halp");
  assert(s && (s.name ?? s.data?.name) === "help", `expected help, got ${s?.name ?? s?.data?.name}`);
});

await test("typo: 'booot' -> boot (slash-only included)", () => {
  const s = findClosestMatch(cands, "booot");
  assert(s && (s.name ?? s.data?.name) === "boot", `expected boot, got ${s?.name ?? s?.data?.name}`);
});

await test("typo: 'punrg' within distance 2 of purge", () => {
  const s = findClosestMatch(cands, "punrg");
  assert(s && (s.name ?? s.data?.name) === "purge", `expected purge, got ${s?.name ?? s?.data?.name}`);
});

await test("typo: no suggestion for garbage", () => {
  const s = findClosestMatch(cands, "xyzzy");
  assert(s === null, `expected null, got ${s?.name ?? s?.data?.name}`);
});

await test("typo via alias: 'abot' -> bot (via alias 'about')", () => {
  const s = findClosestMatch(cands, "abot");
  // Real prefix-only commands carry `name`, not a slash builder —
  // the old fixture's `data.name` accessor only worked on the fake.
  assert(s && (s.name ?? s.data?.name) === "bot", `expected bot, got ${s?.name ?? s?.data?.name}`);
});

// --- headline scenarios rendered exactly like the bot will ---
await test("SCENARIO '>a' full render", () => {
  const m = findStartsWithMatches(cands, "a");
  const out = formatLookupDescription(m);
  console.log("        ── what '>a' shows ──");
  for (const line of out.description.split("\n")) console.log("        " + line);
  assert(out.total >= 4, `expected at least 4 matches, got ${out.total}`);
});

await test("SCENARIO '>se' full render", () => {
  const m = findStartsWithMatches(cands, "se");
  const out = formatLookupDescription(m);
  console.log("        ── what '>se' shows ──");
  for (const line of out.description.split("\n")) console.log("        " + line);
  // 4 real matches: serverinfo + setnick (starts-with), choose +
  // userinfo (contains). The stale pre-Coolsies fixture only knew 3.
  assert(out.total === 4, `expected 4 matches (serverinfo, setnick, choose, userinfo), got ${out.total}`);
});

await test("SCENARIO '>sug' finds suggest via starts-with", () => {
  const m = findStartsWithMatches(cands, "sug");
  const names = m.map((x) => x.command.name ?? x.command.data?.name);
  assert(names.includes("suggest"), "suggest missing");
});

// --- boundary conditions ---
await test("boundary: single char 'c' matches changelog + commands-alias + calc", () => {
  const m = findStartsWithMatches(cands, "c");
  const names = m.map((x) => x.command.name ?? x.command.data?.name);
  assert(names.includes("changelog"), "changelog missing");
  assert(names.includes("calculate"), "calculate missing (alias calc)");
  assert(names.includes("help"), "help missing (alias commands)");
});

await test("boundary: input longer than any name -> empty (falls to typo path)", () => {
  const m = findStartsWithMatches(cands, "serverinfoxxxxx");
  assert(m.length === 0, `expected empty, got ${m.length}`);
});

await test("boundary: MAX_SUGGESTION_DISTANCE export sanity", () => {
  assert(MAX_SUGGESTION_DISTANCE === 2, `expected 2, got ${MAX_SUGGESTION_DISTANCE}`);
});

console.log(failed === 0 ? `\nAll ${passed} checks passed.` : `\n${failed} FAILED, ${passed} passed.`);
process.exitCode = failed === 0 ? 0 : 1;

// cleanup: throwaway DB + settled native teardown (same pattern as
// verify-dispatcher — avoids the better-sqlite3 close/exit race).
const { closeDb } = await import("./dist/database/client.js");
closeDb();
setTimeout(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
  }
  process.exit(failed === 0 ? 0 : 1);
}, 50);
