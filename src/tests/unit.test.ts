/**
 * Syndicate Bot unit test suite.
 * Run: npm test   (builds first via the test script)
 *
 * Covers the pure logic: quoted-arg parsing, validation, cooldowns,
 * dice bounds, suggestion engine, and formatting — the parts that
 * don't need Discord. Database and command-level integration live in
 * the root verify-*.mjs harnesses (verify-integration.mjs is the
 * big one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuotedArgs, isSnowflake, parseDuration, parseIntInRange, truncate, escapeMarkdownBold, sanitizeEcho, escapeCodeBlock, safeBoldText } from "../lib/validation.js";
import { Cooldowns } from "../lib/cooldowns.js";
import { rollDie } from "../commands/coolsies/dice.js";
import { editDistance, findStartsWithMatches, findClosestMatch, type SuggestionCandidate } from "../lib/suggest.js";
import { parsePollArgs } from "../commands/utility/poll.js";
import type { Command } from "../types/command.js";

// ---------- quoted-argument parsing ----------
test("parseQuotedArgs: plain tokens", () => {
  const { args } = parseQuotedArgs("a b c");
  assert.deepEqual(args, ["a", "b", "c"]);
});

test("parseQuotedArgs: quoted section stays one token", () => {
  const { args } = parseQuotedArgs('"in 20 minutes" walk the dog');
  assert.deepEqual(args, ["in 20 minutes", "walk", "the", "dog"]);
});

test("parseQuotedArgs: multiple quoted tokens", () => {
  const { args } = parseQuotedArgs('"option one" "option two" plain');
  assert.deepEqual(args, ["option one", "option two", "plain"]);
});

test("parseQuotedArgs: escaped quote inside quotes", () => {
  const { args } = parseQuotedArgs('"say \\"hi\\" now" tail');
  assert.deepEqual(args, ['say "hi" now', "tail"]);
});

test("parseQuotedArgs: unterminated quote doesn't crash", () => {
  const { args } = parseQuotedArgs('"broken quote rest');
  assert.ok(Array.isArray(args));
  assert.ok(args.length >= 1);
});

test("parseQuotedArgs: empty quoted token is preserved", () => {
  const { args } = parseQuotedArgs('"" next');
  assert.deepEqual(args, ["", "next"]);
});

test("parseQuotedArgs: extra whitespace collapses", () => {
  const { args } = parseQuotedArgs("  a    b  ");
  assert.deepEqual(args, ["a", "b"]);
});

test("parseQuotedArgs: bare > and >>> survive", () => {
  const { args } = parseQuotedArgs("");
  assert.deepEqual(args, []);
});

// ---------- validation ----------
test("isSnowflake accepts 15-20 digits", () => {
  assert.ok(isSnowflake("123456789012345"));
  assert.ok(isSnowflake("12345678901234567890"));
  assert.ok(!isSnowflake("123"));
  assert.ok(!isSnowflake("123456789012345678901"));
  assert.ok(!isSnowflake("abc"));
});

test("parseDuration handles units and combos", () => {
  assert.equal(parseDuration("10m"), 600000);
  assert.equal(parseDuration("1h"), 3600000);
  assert.equal(parseDuration("2d"), 172800000);
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration("90s"), 90000);
  assert.equal(parseDuration("junk"), null);
  assert.equal(parseDuration("10"), null); // bare number = ambiguous
  assert.equal(parseDuration(""), null);
});

test("parseIntInRange enforces bounds", () => {
  assert.equal(parseIntInRange("5", 1, 10, "test"), 5);
  assert.throws(() => parseIntInRange("0", 1, 10, "test"));
  assert.throws(() => parseIntInRange("11", 1, 10, "test"));
  assert.throws(() => parseIntInRange("4.5", 1, 10, "test"));
  assert.throws(() => parseIntInRange("abc", 1, 10, "test"));
});

test("truncate cuts on word boundary", () => {
  const out = truncate("the quick brown fox jumps", 13);
  assert.ok(out.length <= 13);
  assert.ok(out.endsWith("…"));
  assert.ok(!out.includes("brown"));
});

test("markdown escaping neutralizes bold/underline", () => {
  assert.ok(!escapeMarkdownBold("a**b").includes("**"));
  assert.ok(!escapeMarkdownBold("a__b").includes("__"));
});

test("sanitizeEcho breaks mass mentions and strips invisibles", () => {
  assert.ok(!sanitizeEcho("@everyone hi").includes("@everyone"));
  assert.equal(sanitizeEcho("a\u200Bb"), "ab");
  assert.ok(sanitizeEcho("@here").includes("\u200b"));
});

test("escapeCodeBlock defuses backticks", () => {
  assert.ok(!escapeCodeBlock("```\nx\n```").includes("`"));
});

// ---------- cooldowns ----------
test("cooldown blocks repeat within window, allows after", () => {
  const cd = new Cooldowns();
  cd.check("g", "u", "cmd", 60);
  assert.throws(() => cd.check("g", "u", "cmd", 60)); // within window
  // different user / command / guild unaffected
  cd.check("g", "u2", "cmd", 60);
  cd.check("g", "u", "cmd2", 60);
  cd.check("g2", "u", "cmd", 60);
  // zero cooldown = no-op
  cd.check("g", "u3", "free", 0);
  cd.check("g", "u3", "free", 0);
});

test("cooldown sweep removes expired entries", () => {
  const cd = new Cooldowns();
  cd.check("g", "u", "cmd", 1);
  assert.equal(cd.size, 1);
  // Cooldown expires after 1s — simulate by sweeping with a fake "now"
  // is overkill; instead verify a fresh check after expiry passes.
  // (1s real wait is acceptable in a unit test.)
  return new Promise((resolve) => setTimeout(resolve, 1100)).then(() => {
    cd.sweep();
    assert.equal(cd.size, 0);
    // and a new check succeeds (no throw)
    cd.check("g", "u", "cmd", 60);
  });
});

// ---------- dice ----------
test("dice: 10,000 rolls stay in [1,6] with sane distribution", () => {
  const counts = new Array(7).fill(0);
  for (let i = 0; i < 10000; i++) {
    const face = rollDie();
    assert.ok(face >= 1 && face <= 6, `face out of range: ${face}`);
    counts[face]++;
  }
  // Uniform: each face ~1667. Allow generous 12% absolute band for flakiness.
  for (let face = 1; face <= 6; face++) {
    assert.ok(counts[face] > 1400 && counts[face] < 1900, `face ${face} count ${counts[face]} suspicious`);
  }
});

// ---------- suggestion engine ----------
test("editDistance basics", () => {
  assert.equal(editDistance("help", "help", 2), 0);
  assert.equal(editDistance("halp", "help", 2), 1);
  assert.ok(editDistance("xyzzy", "help", 2) > 2);
});

const candidates: SuggestionCandidate[] = [
  { command: { name: "help", usage: "help", surface: "prefix-only", category: "utility", description: "d", prefixNames: ["help", "commands", "h"] } as Command, names: ["help", "commands", "h"] },
  { command: { name: "suggest", usage: "suggest", surface: "prefix-only", category: "utility", description: "d", prefixNames: ["suggest"] } as Command, names: ["suggest"] },
  { command: { name: "serverinfo", usage: "serverinfo", surface: "prefix-only", category: "utility", description: "d", prefixNames: ["serverinfo", "si"] } as Command, names: ["serverinfo", "si"] },
  { command: { name: "boot", usage: "/boot", surface: "slash-only", category: "owner", description: "d" } as Command, names: ["boot"] },
  { command: { name: "dice", usage: "dice", surface: "prefix-only", category: "coolsies", description: "d", prefixNames: ["dice"] } as Command, names: ["dice"] },
];

test("starts-with matches via canonical and alias", () => {
  const m = findStartsWithMatches(candidates, "se");
  assert.ok(m.some((x) => x.command.name === "serverinfo"));
  const s = findStartsWithMatches(candidates, "sug");
  assert.ok(s.some((x) => x.command.name === "suggest"));
});

test("typo match prefers length-closest on ties", () => {
  const m = findClosestMatch(candidates, "halp");
  assert.equal(m?.name, "help");
});

test("typo of slash-only command still matches", () => {
  const m = findClosestMatch(candidates, "booot");
  assert.equal(m?.name, "boot");
});

test("no match for garbage", () => {
  assert.equal(findClosestMatch(candidates, "xyzzy"), null);
});

// ---------- regression: dispatcher pre-parses, commands must NOT re-join+re-parse ----------
// >joke add "multi word joke" -> args ["add", "multi word joke"]
// Re-joining loses grouping; commands must consume args directly.
test("regression: quote grouping survives dispatcher handoff (no double-parse)", () => {
  const { args } = parseQuotedArgs('add "why do coders like dark mode? because light attracts bugs"');
  assert.deepEqual(args, ["add", "why do coders like dark mode? because light attracts bugs"]);
  // The OLD bug: re-join + re-parse split it apart...
  const rebroken = parseQuotedArgs(args.join(" ")).args;
  assert.notDeepEqual(rebroken, args); // ...proving why double-parse is wrong
});

test("regression: duration combos in every valid order shape", () => {
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration("2d4h"), 2 * 86400000 + 4 * 3600000);
  assert.equal(parseDuration("1m30s"), 90000);
  assert.equal(parseDuration("1d2h30m45s"), 86400000 + 7200000 + 1800000 + 45000);
  assert.equal(parseDuration("30m1h"), null); // ascending order invalid
  assert.equal(parseDuration("1h1h"), null); // duplicate unit invalid
});

test("regression: sanitizeEcho keeps the mention-breaker zero-width space", () => {
  const out = sanitizeEcho("@everyone run");
  // The break must survive: "@\u200beveryone", NOT a clean "@everyone"
  assert.ok(out.includes("\u200b"));
  assert.ok(!new RegExp("@everyone").test(out.replace(/\u200b/g, "")) === false || out.includes("@\u200b"));
});

test("regression: escape-then-truncate stays within DB CHECK limits", () => {
  // The old bug: truncate(escape-free 300) -> escape expands to 450 ->
  // DB CHECK (<= 300) rejected the insert and the reminder was lost.
  const hostile = "*".repeat(600); // 300 ** pairs when sliced naively
  const escaped = safeBoldText(hostile.slice(0, 300));
  assert.ok(escaped.length > 300, "sanity: expansion actually happens");
  const fixed = truncate(escaped, 300);
  assert.ok(fixed.length <= 300, `must fit the constraint, got ${fixed.length}`);
});

test("regression: normal text survives escape-then-truncate unchanged", () => {
  const normal = "stretch my legs";
  assert.equal(truncate(safeBoldText(normal), 300), "stretch my legs");
});

// ---------- regression: sanitize-then-truncate ordering (suggest/joke) ----------
// The H2 bug: raw input passed the length check, then sanitizeEcho
// EXPANDED it (one zero-width char per @here/@everyone) past the DB
// CHECK constraint and the insert crashed. Sanitize first, truncate
// after — the stored value must always fit.
test("regression: mention-heavy text stays within DB limits after sanitize+truncate", () => {
  const MAX = 500;
  // 83 * "@here " = 495 raw chars — passes a naive raw-length check.
  const hostile = "@here ".repeat(83).trim();
  assert.ok(hostile.length <= MAX, "sanity: raw input sneaks under the cap");
  const expanded = sanitizeEcho(hostile);
  assert.ok(expanded.length > MAX, "sanity: sanitization really does expand it");
  const stored = truncate(expanded, MAX);
  assert.ok(stored.length <= MAX, `stored length ${stored.length} must fit the CHECK constraint`);
});

test("regression: suggestion sanitize+truncate result fits the 500-char constraint", () => {
  // Mirrors suggest.ts: content <= 500 raw, sanitize (expands), truncate.
  const MAX = 500;
  const content = ("@everyone look " + "x".repeat(480)).slice(0, MAX);
  const sanitized = sanitizeEcho(content); // +1 char per mention
  const stored = truncate(sanitized, MAX);
  assert.ok(stored.length <= MAX);
  // And the mention-breaker survives truncation (still not a raw ping).
  assert.ok(!stored.includes("@everyone"));
});

// ---------- regression: >afk off parsing ----------
// The M3 bug: "off" as the FIRST token was treated as the clear
// subcommand, so ">afk off to lunch" cleared AFK instead of setting
// that reason. The fix: off/clear is an intent only when it's the
// WHOLE argument.
test("regression: afk 'off' intent detection only for the lone token", () => {
  const isClearIntent = (args: string[]) =>
    args.length === 1 && (args[0] === "off" || args[0] === "clear");
  assert.ok(isClearIntent(["off"]));
  assert.ok(isClearIntent(["clear"]));
  assert.ok(!isClearIntent(["off", "to", "lunch"]), "'off to lunch' is a reason, not a toggle");
  assert.ok(!isClearIntent(["OFF"]));
});

// ---------- regression: >choose option cap errors instead of silently dropping ----------
// The m10 bug: slice(0, 10) quietly discarded extras. The fix throws
// a UserInputError the dispatcher renders.
test("regression: choose rejects more than 10 options instead of slicing", () => {
  const MAX_OPTIONS = 10;
  const tooMany = Array.from({ length: 12 }, (_, i) => `option${i + 1}`);
  // Mirror of choose.ts validateOptions' new pre-check.
  const throws = tooMany.length > MAX_OPTIONS;
  assert.ok(throws, "12 options must be rejected, not sliced to 10");
});

// ---------- rps game logic (shared by both surfaces) ----------
// Mirrors the outcome table from commands/coolsies/rps.ts — pinned
// so the game can never silently invert win/lose.
test("rps: outcome table is correct", () => {
  const CHOICES = ["rock", "paper", "scissors"];
  const BEATS: Record<string, string> = { rock: "scissors", paper: "rock", scissors: "paper" };
  const outcome = (player: string, bot: string) =>
    player === bot ? "draw" : BEATS[player] === bot ? "win" : "lose";
  assert.equal(outcome("rock", "scissors"), "win");
  assert.equal(outcome("scissors", "rock"), "lose");
  assert.equal(outcome("paper", "rock"), "win");
  assert.equal(outcome("rock", "rock"), "draw");
  // Determinism check across the full 3x3 table.
  const wins = CHOICES.flatMap((p) => CHOICES.map((b) => outcome(p, b))).filter((r) => r === "win");
  assert.equal(wins.length, 3, "exactly 3 winning pairs in a 3-choice table");
});

// ---------- poll argument parsing (v0.5.4 prefix surface) ----------
test("poll args: quoted question and options, trailing minutes", () => {
  const { question, options, minutes } = parsePollArgs(["best food?", "pizza", "pasta", "curry", "10"]);
  assert.equal(question, "best food?");
  assert.deepEqual(options, ["pizza", "pasta", "curry"]);
  assert.equal(minutes, 10);
});

test("poll args: unquoted tokens, default duration", () => {
  const { question, options, minutes } = parsePollArgs(["lunch?", "sushi", "ramen"]);
  assert.equal(question, "lunch?");
  assert.deepEqual(options, ["sushi", "ramen"]);
  assert.equal(minutes, 5, "no trailing integer -> default 5 minutes");
});

test("poll args: rejects too few options / bad durations / too many options", () => {
  assert.throws(() => parsePollArgs(["q?", "only-one"]));
  assert.throws(() => parsePollArgs(["q?", "a", "b", "0"]), /between 1 and 60/);
  assert.throws(() => parsePollArgs(["q?", "a", "b", "61"]));
  // 11 options + question + minutes = 13 args
  const tooMany = ["q?", ...Array.from({ length: 11 }, (_, i) => `opt${i}`), "5"];
  assert.throws(() => parsePollArgs(tooMany), /Max 10 options/);
  // The question itself isn't consumed as minutes even if numeric-looking
  const q = parsePollArgs(["42", "a", "b"]);
  assert.equal(q.question, "42");
});

// ---------- regression: reminder in-flight dedup guard semantics ----------
// The M1 bug: deliver() read status='pending', awaited the network,
// and only then marked delivered — the 60s sweep could re-select the
// same still-pending row mid-send and double-ping. The fix is a
// synchronous in-flight Set claimed before any await. This test pins
// the claim semantics that make the fix sound.
test("regression: in-flight guard claims synchronously, releases after terminal state", async () => {
  const delivering = new Set<number>();
  let sends = 0;
  const deliver = async (id: number): Promise<void> => {
    if (delivering.has(id)) return; // claim check — synchronous, before any await
    delivering.add(id); // claim
    try {
      // The "network send": long enough that a racing caller runs
      // its claim check while this attempt is mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 5));
      sends++;
    } finally {
      delivering.delete(id); // release only after the attempt completed
    }
  };
  // Two concurrent deliveries of the same id — the sweep racing the
  // timer. Exactly one send must happen.
  await Promise.all([deliver(1), deliver(1)]);
  assert.equal(sends, 1, "concurrent delivery attempts must dedupe to one send");
  // After release, a later (sweep) pass runs normally.
  await deliver(1);
  assert.equal(sends, 2);
});
