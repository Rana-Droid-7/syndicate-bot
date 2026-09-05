/**
 * Extensive tests for the prefix lookup system (lib/suggest.ts).
 * Run: node verify_lookup.mjs   (requires `npm run build` first)
 *
 * Tests the exact user-facing scenarios plus edge cases:
 *   ">a"  -> lists every command starting with "a", each with usage
 *   ">se" -> lists serverinfo, setnick, suggest ... with usage
 *   ">halp" -> typo suggestion for /help with usage
 *   visibility, caps, digits, boundaries, caps, empty results...
 */

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

// Build a realistic candidate set mirroring the live bot's commands:
// name -> [names], slashOnly flag, category
function makeCandidates() {
  const defs = [
    { name: "help", aliases: ["help", "commands", "h"], prefix: true },
    { name: "ping", aliases: ["ping", "latency"], prefix: true },
    { name: "bot", aliases: ["bot", "botinfo", "about"], prefix: true },
    { name: "suggest", aliases: ["suggest", "suggestion"], prefix: true },
    { name: "userinfo", aliases: ["userinfo", "whois", "ui"], prefix: true },
    { name: "serverinfo", aliases: ["serverinfo", "guildinfo", "si"], prefix: true },
    { name: "avatar", aliases: ["avatar", "av", "pfp"], prefix: true },
    { name: "banner", aliases: ["banner"], prefix: true },
    { name: "timestamp", aliases: ["timestamp", "ts"], prefix: true },
    { name: "snowflake", aliases: ["snowflake", "decode"], prefix: true },
    { name: "afk", aliases: ["afk"], prefix: true },
    { name: "remindme", aliases: ["remindme", "remind"], prefix: true },
    { name: "roll", aliases: ["roll", "dice"], prefix: true },
    { name: "calculate", aliases: ["calculate", "calc", "math"], prefix: true },
    { name: "invite", aliases: ["invite"], prefix: true },
    { name: "changelog", aliases: ["changelog", "changes"], prefix: true },
    { name: "poll", aliases: [], prefix: false },
    { name: "kick", aliases: [], prefix: false },
    { name: "ban", aliases: [], prefix: false },
    { name: "timeout", aliases: [], prefix: false },
    { name: "warn", aliases: [], prefix: false },
    { name: "purge", aliases: [], prefix: false },
    { name: "announce", aliases: [], prefix: false },
    { name: "setnick", aliases: [], prefix: false },
    { name: "slowmode", aliases: [], prefix: false },
    { name: "boot", aliases: [], prefix: false },
  ];

  return defs.map((d) => ({
    command: {
      // v0.5.4 Command metadata shape: prefix-only commands carry a
      // prefix-FREE usage string (the renderer adds the env prefix);
      // slash-only ones keep the literal "/name".
      ...(d.prefix
        ? { data: { name: d.name, toJSON: () => ({ name: d.name, options: [] }) } }
        : {}),
      name: d.name,
      category: "utility",
      usage: d.prefix ? d.name : `/${d.name}`,
      surface: d.prefix ? "prefix-only" : "slash-only",
      prefixExecute: d.prefix ? async () => {} : undefined,
    },
    names: d.prefix ? [...new Set([d.name, ...d.aliases])] : [d.name],
  }));
}

const cands = makeCandidates();

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
  assert(s && s.data.name === "bot", `expected bot, got ${s?.name ?? s?.data?.name}`);
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
  assert(out.total === 3, `expected 3 matches (serverinfo, setnick, userinfo), got ${out.total}`);
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
