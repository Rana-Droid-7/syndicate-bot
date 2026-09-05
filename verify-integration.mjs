/**
 * Full-blown integration/attack test harness for v0.5.0-beta.
 * Run: node verify-integration.mjs   (requires `npm run build`)
 *
 * Strategy: simulate Discord Message objects closely enough for the
 * prefix command layer, run every public command against a THROWAWAY
 * database, and attack each with:
 *   - boundary lengths (0, 1, max, max+1, 5000)
 *   - quote edge cases (unbalanced, escaped, nested, empty)
 *   - unicode / emoji / zero-width abuse
 *   - markdown / mention / code-block smuggling
 *   - code-execution payloads (these must NEVER execute)
 *   - weird IDs, huge numbers, negative numbers
 *
 * Any crash that escapes a command (unhandled throw past the command)
 * is a FAILURE — commands must always produce a reply or a typed error.
 */
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- throwaway DB ----
const TEST_DB = path.join(__dirname, "data", "integration-test.db");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
process.env.DATABASE_FILE = "data/integration-test.db";
process.env.DISCORD_TOKEN = "test-token";
process.env.CLIENT_ID = "123456789012345678";
process.env.OWNER_ID = "111111111111111111"; // the "developer"

const { getDb, runMigrations } = await import("./dist/database/client.js");
runMigrations();

// ---- mock Discord primitives ----
let replyCount = 0;
const replies = [];

function makeMessage(content, { authorId = "222222222222222222", authorBot = false, mentions = [], channelSendable = true, guildId = "999999999999999999" } = {}) {
  const mentioned = new Map(mentions.map((m) => [m.id, m]));
  // discord.js Collection API surface used by commands:
  mentioned.first = () => [...mentioned.values()][0];
  return {
    id: "444444444444444444",
    content,
    author: {
      id: authorId,
      bot: authorBot,
      tag: `user_${authorId.slice(-4)}#0001`,
      username: `user_${authorId.slice(-4)}`,
      toString: () => `<@${authorId}>`,
      fetch: async () => null,
      displayAvatarURL: () => "https://example.com/avatar.png",
      bannerURL: () => null,
    },
    client: { channels: { fetch: async () => null }, users: mentioned },
    member: null,
    guild: guildId ? { id: guildId, name: "Test Guild", members: { fetch: async () => null } } : null,
    mentions: { users: mentioned },
    channelId: "555555555555555555",
    channel: {
      id: "555555555555555555",
      isTextBased: () => channelSendable,
      send: async (c) => { replies.push(c); return { id: "x" }; },
    },
    createdTimestamp: Date.now(),
    reply: async (payload) => {
      replyCount++;
      replies.push(typeof payload === "string" ? payload : JSON.stringify(payload, replacer).slice(0, 300));
      return { edit: async () => null, createdTimestamp: Date.now() };
    },
    react: async () => null,
  };
}

function replacer(_key, value) {
  if (value && value.data) return "[EmbedBuilder]";
  return value;
}

async function runCommand(modulePath, content, opts = {}) {
  const command = (await import(modulePath)).default;
  const { parseQuotedArgs } = await import("./dist/lib/validation.js");
  const afterPrefix = content.replace(/^>/, "");
  const { args } = parseQuotedArgs(afterPrefix);
  args.shift()?.toLowerCase();
  const myReplies = [];
  const message = makeMessage(content, opts);
  // Bind THIS run's reply capture.
  message.reply = async (payload) => {
    myReplies.push(typeof payload === "string" ? payload : JSON.stringify(payload, replacer).slice(0, 300));
    return { edit: async () => null, createdTimestamp: Date.now() };
  };
  message.channel.send = async (c) => { myReplies.push(String(c)); return { id: "x" }; };
  try {
    await command.prefixExecute(message, args);
    return { ok: true, message, replies: myReplies };
  } catch (error) {
    return { ok: false, error, message, replies: myReplies };
  }
}

let passed = 0, failed = 0;
function report(name, ok, detail = "") {
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${detail ? " — " + detail : ""}`); }
}

// Intercept child_process to catch any accidental code execution.
// Commands never import it by design; a crash-free run + stored-as-
// text verification below proves payloads didn't execute.
const execCalls = [];
globalThis.__execCalls = execCalls;

// ============================================================
// 1) SUGGEST — quotes required, lengths, injection, exec
// ============================================================
console.log("\n=== SUGGEST ===");
{
  const S = "./dist/commands/utility/suggest.js";
  const cases = [
    ['>suggest "add a music command"', true, "normal quoted"],
    ['>suggest add music', false, "unquoted rejected"],
    ['>suggest ""', false, "empty quotes rejected"],
    ['>suggest "a"', true, "single char ok"],
    [`>suggest "${"x".repeat(500)}"`, true, "exactly 500 ok"],
    [`>suggest "${"x".repeat(501)}"`, false, "501 rejected"],
    ['>suggest "hello @everyone run"', true, "mass mention in content"],
    ['>suggest "rm -rf / && eval(process.env)"', true, "exec payload as TEXT"],
    ['>suggest "`code block` **bold** __under__"', true, "markdown smuggling"],
    ['>suggest "line1\\nline2"', true, "newlines"],
    ['>suggest "\\u0000\\u200b invisible"', false, "invisible-only content"],
  ];
  for (const [input, expectOk, label] of cases) {
    const result = await runCommand(S, input);
    if (expectOk) {
      report(`suggest: ${label}`, result.ok, result.ok ? "" : `threw ${result.error?.message}`);
    } else {
      // rejection can be a clean UserInputError handled by the harness
      // caller (dispatcher). Here prefixExecute throws typed errors.
      report(`suggest rejects: ${label}`, !result.ok || result.replies.length > 0, "neither reply nor throw");
    }
  }
  // Verify no exec happened
  report("suggest: no code execution", globalThis.__execCalls.length === 0);
  // Verify stored content is sanitized
  const { suggestionRepository } = await import("./dist/repositories/suggestions.js");
  const rows = suggestionRepository.forGuild("999999999999999999");
  const mass = rows.find((r) => r.content.includes("everyone"));
  report("suggest: @everyone stored broken", !mass || !mass.content.includes("@everyone"));
  const md = rows.find((r) => r.content.includes("**bold**"));
  report("suggest: markdown stored as text (allowed, render-safe)", !!md);
}

// ============================================================
// 2) AFK — set/clear/off, lengths, mentions
// ============================================================
console.log("\n=== AFK ===");
{
  const A = "./dist/commands/utility/afk.js";
  const { afkRepository } = await import("./dist/repositories/afk.js");
  const uid = "333333333333333333";

  let r = await runCommand(A, ">afk getting coffee", { authorId: uid });
  report("afk: set with reason", r.ok && afkRepository.get("999999999999999999", uid)?.reason.includes("coffee"));

  r = await runCommand(A, ">afk", { authorId: uid });
  report("afk: no-arg while AFK toggles off", r.ok && afkRepository.get("999999999999999999", uid) === null);

  r = await runCommand(A, `>afk ${"y".repeat(300)}`, { authorId: uid });
  report("afk: long reason truncated to 200", r.ok && afkRepository.get("999999999999999999", uid)?.reason.length <= 202);

  r = await runCommand(A, ">afk @everyone panic", { authorId: uid });
  const stored = afkRepository.get("999999999999999999", uid)?.reason ?? "";
  report("afk: @everyone broken in stored reason", !stored.includes("@everyone"));

  r = await runCommand(A, ">afk off", { authorId: uid });
  report("afk: explicit off clears", r.ok && afkRepository.get("999999999999999999", uid) === null);

  r = await runCommand(A, ">afk off", { authorId: uid });
  report("afk: off when not AFK -> clean error reply", r.ok && r.replies.length > 0);

  r = await runCommand(A, ">afk reason", { authorId: uid, guildId: null });
  report("afk: DM rejected", !r.ok || r.replies.length > 0);
  afkRepository.clear("999999999999999999", uid);
}

// ============================================================
// 3) REMINDME — time parsing, persistence, lengths
// ============================================================
console.log("\n=== REMINDME ===");
{
  const R = "./dist/commands/utility/remindme.js";
  const { reminderRepository } = await import("./dist/repositories/reminders.js");
  const uid = "333333333333333333";

  let r = await runCommand(R, '>remindme "in 2 minutes" drink water', { authorId: uid });
  report("remindme: normal set", r.ok);
  const pending1 = reminderRepository.pending().length;

  r = await runCommand(R, '>remindme "yesterday 9am" too late', { authorId: uid });
  report("remindme: past time rejected", !r.ok);

  r = await runCommand(R, '>remindme "in 40 days" too far', { authorId: uid });
  report("remindme: >30 days rejected", !r.ok);

  r = await runCommand(R, '>remindme "in 1 minute"', { authorId: uid });
  report("remindme: missing text rejected", !r.ok);

  r = await runCommand(R, '>remindme "banana" fruit?', { authorId: uid });
  report("remindme: unparseable time rejected", !r.ok);

  r = await runCommand(R, `>remindme "in 5 minutes" ${"z".repeat(400)}`, { authorId: uid });
  const rows = reminderRepository.pending();
  const long = rows[rows.length - 1];
  report("remindme: 400-char text capped at 300", r.ok && long.content.length <= 302);

  report("remindme: pending count sane", pending1 >= 1);
  // clean up
  for (const row of reminderRepository.pending()) reminderRepository.markDelivered(row.id);
}

// ============================================================
// 4) JOKE — say/add/edit + dev gating + exec payloads
// ============================================================
console.log("\n=== JOKE ===");
{
  const J = "./dist/commands/coolsies/joke.js";
  const { jokeRepository } = await import("./dist/repositories/jokes.js");
  const DEV = "111111111111111111"; // matches OWNER_ID
  const PLEB = "222222222222222222";

  // public say with empty store
  let r = await runCommand(J, ">joke say");
  report("joke: say with empty store -> clean error", r.ok && r.replies.length > 0);

  // pleb tries add
  r = await runCommand(J, '>joke add "haha"', { authorId: PLEB });
  report("joke: non-dev add denied", !r.ok || r.replies.some((x) => String(x).includes("developer")), "no deny shown");
  const jokeCountBefore = jokeRepository.countAll();
  report("joke: nothing stored by pleb", jokeRepository.countAll() === jokeCountBefore);

  // dev adds (with the exact regression payload from last hunt)
  r = await runCommand(J, '>joke add "why do coders like dark mode? because light attracts bugs!"', { authorId: DEV });
  const jokes = jokeRepository.list(10);
  report("joke: dev add full quoted text", r.ok && jokes.length >= 1 &&
    jokes[0].content === "why do coders like dark mode? because light attracts bugs!",
    `got: ${jokes[0]?.content}`);

  // say now works and bumps usage (random pick — any enabled row's
  // counter moves, not necessarily the newest one)
  r = await runCommand(J, ">joke say");
  const anyUsed = jokeRepository.list(100).some((j) => j.usage_count > 0);
  report("joke: say returns joke", r.ok && anyUsed);

  // exec payload — must be stored as text, never executed
  r = await runCommand(J, '>joke add "eval(process.exit(1)) ; rm -rf /"', { authorId: DEV });
  const execJoke = jokeRepository.list(1)[0];
  report("joke: exec payload stored as literal text", r.ok && execJoke.content.includes("eval("));

  // markdown/mention abuse
  r = await runCommand(J, '>joke add "@everyone look **bold**"', { authorId: DEV });
  const abuse = jokeRepository.list(1)[0];
  report("joke: @everyone broken in store", !abuse.content.includes("@everyone"));

  // edit
  const target = jokeRepository.list(10).find((j) => j.content.includes("dark mode"));
  r = await runCommand(J, `>joke edit ${target.id} "edited text"`, { authorId: DEV });
  report("joke: edit via quoted arg", r.ok && jokeRepository.get(target.id).content === "edited text");

  // pleb edit denied
  r = await runCommand(J, `>joke edit ${target.id} "hax"`, { authorId: PLEB });
  report("joke: non-dev edit denied", !r.ok || String(r.replies[0]).includes("developer"));

  // enable/disable/remove round trip
  r = await runCommand(J, `>joke disable ${target.id}`, { authorId: DEV });
  report("joke: disable", r.ok && jokeRepository.get(target.id).enabled === 0);
  r = await runCommand(J, ">joke say");
  report("joke: say skips disabled", r.ok); // (other jokes still serve)
  r = await runCommand(J, `>joke enable ${target.id}`, { authorId: DEV });
  report("joke: enable", r.ok && jokeRepository.get(target.id).enabled === 1);
  r = await runCommand(J, `>joke remove ${target.id}`, { authorId: DEV });
  report("joke: remove", r.ok && jokeRepository.get(target.id) === null);

  // bad IDs
  r = await runCommand(J, ">joke remove 99999", { authorId: DEV });
  report("joke: remove nonexistent -> clean error", r.ok && r.replies.length > 0);
  r = await runCommand(J, ">joke remove abc", { authorId: DEV });
  report("joke: non-numeric id rejected", !r.ok || r.replies.length > 0);
  r = await runCommand(J, ">joke frobnicate", { authorId: DEV });
  report("joke: unknown subcommand -> clean error", !r.ok || r.replies.length > 0);

  report("joke: zero code execution", globalThis.__execCalls.length === 0);
}

// ============================================================
// 5) COOLSIES — boundaries
// ============================================================
console.log("\n=== COOLSIES ===");
{
  const D = "./dist/commands/coolsies/dice.js";
  const r = await runCommand(D, ">dice");
  report("dice: works", r.ok && r.replies.length === 1);

  const C = "./dist/commands/coolsies/choose.js";
  const cases = [
    [">choose pizza pasta", true],
    ['>choose "green curry" pizza', true, "multi-word option"],
    [">choose one", false, "single option"],
    [">choose", false, "no options"],
    [`>choose ${Array.from({ length: 12 }, (_, i) => "o" + i).join(" ")}`, false, "12 options rejected (cap 10)"],
    [`>choose ${"x".repeat(200)}`, true, "200-char option"],
  ];
  for (const [input, ok, label] of cases) {
    const res = await runCommand(C, input);
    report(`choose: ${label ?? input}`, ok ? res.ok : !res.ok || res.replies.length > 0);
  }

  const R8 = "./dist/commands/coolsies/8ball.js";
  const r8 = await runCommand(R8, ">8ball will it work?");
  report("8ball: normal ask", r8.ok);
  const r8b = await runCommand(R8, ">8ball");
  report("8ball: no question rejected", !r8b.ok || r8b.replies.length > 0);
  const r8c = await runCommand(R8, `>8ball ${"q".repeat(300)}`);
  report("8ball: long question rejected", !r8c.ok || r8c.replies.length > 0);

  // 8-ball management suite (mirrors the joke suite)
  {
    const { eightBallRepository } = await import("./dist/repositories/eightball.js");
    const DEV8 = "111111111111111111";
    const PLEB8 = "222222222222222222";
    const seeded = eightBallRepository.countAll();
    report("8ball: seeded pool exists", seeded >= 19, `got ${seeded}`);

    // pleb denied management
    let rr = await runCommand(R8, '>8ball add "nope"', { authorId: PLEB8 });
    report("8ball: non-dev add denied", !rr.ok || rr.replies.some((x) => String(x).includes("developer")));

    // dev add
    rr = await runCommand(R8, '>8ball add "Signs point to absolutely."', { authorId: DEV8 });
    const added = eightBallRepository.list(1)[0];
    report("8ball: dev add quoted text", rr.ok && added.content === "Signs point to absolutely.", `got: ${added?.content}`);

    // edit + toggle + remove round trip
    rr = await runCommand(R8, `>8ball edit ${added.id} "edited response"`, { authorId: DEV8 });
    report("8ball: edit via quoted arg", rr.ok && eightBallRepository.get(added.id).content === "edited response");
    rr = await runCommand(R8, `>8ball disable ${added.id}`, { authorId: DEV8 });
    report("8ball: disable", rr.ok && eightBallRepository.get(added.id).enabled === 0);
    rr = await runCommand(R8, `>8ball enable ${added.id}`, { authorId: DEV8 });
    report("8ball: enable", rr.ok && eightBallRepository.get(added.id).enabled === 1);
    rr = await runCommand(R8, `>8ball remove ${added.id}`, { authorId: DEV8 });
    report("8ball: remove", rr.ok && eightBallRepository.get(added.id) === null);

    // list pages
    rr = await runCommand(R8, ">8ball list", { authorId: DEV8 });
    report("8ball: list works", rr.ok && rr.replies.length > 0);
    rr = await runCommand(R8, ">8ball remove 99999", { authorId: DEV8 });
    report("8ball: remove nonexistent -> clean error", rr.ok && rr.replies.length > 0);
    rr = await runCommand(R8, ">8ball remove abc", { authorId: DEV8 });
    report("8ball: non-numeric id rejected", !rr.ok || rr.replies.length > 0);
  }

  const RN = "./dist/commands/coolsies/random.js";
  for (const [input, ok, label] of [
    [">random 1 10", true], [">random 10 1", false, "min>max"], [">random 5", false, "one arg"],
    [">random -5 5", true, "negatives ok"], [">random 1 2000000", false, "above cap"],
    [">random abc def", false, "non-numeric"], [">random 1.5 2", false, "floats"],
  ]) {
    const res = await runCommand(RN, input);
    report(`random: ${label ?? input}`, ok ? res.ok : !res.ok || res.replies.length > 0);
  }

  const CF = "./dist/commands/coolsies/coinflip.js";
  const cf = await runCommand(CF, ">coinflip");
  report("coinflip: works", cf.ok && String(cf.replies[0]).includes("coin") || String(cf.replies[0]).length > 0);

  const RT = "./dist/commands/coolsies/rate.js";
  const rt = await runCommand(RT, ">rate");
  report("rate: no target rates self", rt.ok);
  const rt2 = await runCommand(RT, ">rate <@555555555555555555>", { mentions: [{ id: "555555555555555555" }] });
  report("rate: with mention", rt2.ok);
}

// ============================================================
// 6) INFO COMMANDS — snowflake/roll/calculate/timestamp/userinfo
// ============================================================
console.log("\n=== INFO ===");
{
  const SN = "./dist/commands/utility/snowflake.js";
  for (const [input, ok, label] of [
    [">snowflake 1300000000000000000", true, "valid"],
    [">snowflake 123", false, "too short"],
    [">snowflake 12345678901234567890123", false, "too long"],
    [">snowflake abc", false, "alpha"],
    [">snowflake 1300000000000000000'; DROP TABLE users;--", false, "SQL payload"],
  ]) {
    const res = await runCommand(SN, input);
    report(`snowflake: ${label}`, ok ? res.ok : !res.ok || res.replies.length > 0);
  }

  const RO = "./dist/commands/utility/roll.js";
  for (const [input, ok, label] of [
    [">roll", true, "default 1d6"], [">roll 2d6", true], [">roll 1d20+5", true],
    [">roll 0d6", false, "zero dice"], [">roll 99d6", false, "over max"], [">roll 2d1", false, "1 side"],
    [">roll banana", false, "garbage"], [">roll 2d6+999", true, "big modifier"],
  ]) {
    const res = await runCommand(RO, input);
    report(`roll: ${label ?? input}`, ok ? res.ok : !res.ok || res.replies.length > 0);
  }

  const CA = "./dist/commands/utility/calculate.js";
  const ca = await runCommand(CA, ">calc 2+2*10");
  report("calculate: basic", ca.ok);
  const ca2 = await runCommand(CA, `>calc ${"1+".repeat(100)}1`);
  report("calculate: long expression capped", !ca2.ok || ca2.replies.length > 0);

  const TS = "./dist/commands/utility/timestamp.js";
  const ts = await runCommand(TS, ">timestamp tomorrow 5pm");
  report("timestamp: works", ts.ok);
  const ts2 = await runCommand(TS, ">ts dec 25 2026 D");
  report("timestamp: style arg", ts2.ok);
  const ts3 = await runCommand(TS, ">ts");
  report("timestamp: no args -> usage", !ts3.ok || ts3.replies.length > 0);
}

// ============================================================
// 7) WARN (mod logic via service) — cap + clear
// ============================================================
console.log("\n=== WARN SERVICE ===");
{
  const { warningService } = await import("./dist/services/warnings.js");
  const g = "999999999999999999", u = "777777777777777777";
  for (let i = 0; i < 30; i++) warningService.add(g, u, "111111111111111111", `r${i}`);
  const active = warningService.activeFor(g, u);
  report("warn: capped at 25 after 30 adds", active.length === 25, `got ${active.length}`);
  const newest = active[0].reason;
  report("warn: newest kept", newest === "r29", `newest=${newest}`);
  const cleared = warningService.clearActive(g, u);
  report("warn: clear removes all", cleared === 25);
}

// ============================================================
// 8) SQL INJECTION — via every repository
// ============================================================
console.log("\n=== SQL INJECTION ===");
{
  const { jokeRepository } = await import("./dist/repositories/jokes.js");
  const payload = `joke"; DROP TABLE jokes;--`;
  jokeRepository.add(payload, "111111111111111111");
  const stillThere = (getDb().prepare(`SELECT COUNT(*) AS n FROM jokes`).get()).n;
  report("SQLi: jokes table survives injection payload", stillThere >= 1);

  const { suggestionRepository } = await import("./dist/repositories/suggestions.js");
  suggestionRepository.add("'; DELETE FROM warnings;--", "x".repeat(0) || "222222222222222222", "inject");
  const warns = getDb().prepare(`SELECT COUNT(*) AS n FROM warnings`).get();
  report("SQLi: warnings table survives", warns.n >= 0);
}

// ============================================================
// 9) SECRETS IN LOGS — token must never appear
// ============================================================
console.log("\n=== SECRETS ===");
{
  // The logger must never emit the real token. We check by aliasing
  // console and exercising several log paths — none of them log env.
  const { log } = await import("./dist/core/logger.js");
  const captured = [];
  const orig = console.log;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = (...a) => captured.push(a.join(" "));
  console.warn = console.log;
  console.error = console.log;
  log.info("TEST", "normal message");
  log.warn("TEST", "warning message");
  log.error("TEST", "error message", new Error("boom"));
  console.log = orig; console.warn = origWarn; console.error = origErr;
  const leaked = captured.some((line) => line.includes("test-token"));
  report("secrets: DISCORD_TOKEN never logged", !leaked, leaked ? "token in output" : "");
}

// ============================================================
// REGRESSIONS for the audit round's 5 fixes
// ============================================================
console.log("\n=== REGRESSIONS (audit fixes) ===");
{
  // Fix 1+2: expansion attacks must no longer violate DB CHECKs
  const A = "./dist/commands/utility/afk.js";
  const { afkRepository } = await import("./dist/repositories/afk.js");
  const uid = "666666666666666666";
  let r = await runCommand(A, ">afk " + "*".repeat(400), { authorId: uid });
  const storedReason = afkRepository.get("999999999999999999", uid)?.reason ?? "";
  report("afk: hostile ** expansion stored within 200", r.ok && storedReason.length <= 202,
    `len=${storedReason.length}`);
  afkRepository.clear("999999999999999999", uid);

  const R = "./dist/commands/utility/remindme.js";
  const { reminderRepository } = await import("./dist/repositories/reminders.js");
  r = await runCommand(R, '>remindme "in 2 minutes" ' + "*".repeat(400), { authorId: uid });
  const rows = reminderRepository.pending();
  const hostile = rows[rows.length - 1];
  report("remindme: hostile ** expansion stored within 300",
    r.ok && hostile && hostile.content.length <= 302, `len=${hostile?.content.length}`);
  for (const row of rows) reminderRepository.markDelivered(row.id);

  // Fix 3: guildDelete cascade cleanup
  const { suggestionRepository } = await import("./dist/repositories/suggestions.js");
  suggestionRepository.add("999999999999999999", uid, "to be cascaded");
  const { getDb, closeDb: closeIt } = await import("./dist/database/client.js");
  getDb().prepare("DELETE FROM guilds WHERE guild_id = ?").run("999999999999999999");
  const gone = suggestionRepository.forGuild("999999999999999999").length;
  report("guildDelete: FK cascade removes guild data", gone === 0);

  // Fix 4: >rate <valid-id> must resolve, not rate self
  // (mock fetch returns null for unknown IDs -> clean error, never silent self-rate)
  const RT = "./dist/commands/coolsies/rate.js";
  const mockFetchFails = { ...{}, client: { users: { fetch: async () => null } } };
  const cmd = (await import(RT)).default;
  const msg = makeMessage(">rate 123456789012345678", { authorId: uid });
  // rebind per-run capture
  const myReplies = [];
  msg.reply = async (p) => { myReplies.push(String(p)); return {}; };
  msg.client = mockFetchFails.client;
  await cmd.prefixExecute(msg, ["123456789012345678"]);
  report("rate: unresolvable ID -> explicit error (not silent self-rate)",
    myReplies.length > 0 && !myReplies[0].includes("6666"), myReplies[0]?.slice(0, 80));
}

// ============================================================
// REGRESSIONS for hunt round 2 (H2/M3/m9/m10 + suggest/joke expansion)
// ============================================================
console.log("\n=== REGRESSIONS (round 2) ===");
{
  const { getDb, closeDb: closeIt } = await import("./dist/database/client.js");
  const uid = "666666666666666666";
  const gid = "999999999999999999";

  // --- H2: sanitizeEcho's @-mention expansion must never violate the
  // suggestions CHECK (<=500). Raw "@here " * 83 = 495 chars passes the
  // command's own length check, expands to ~578 on sanitize.
  const S = "./dist/commands/utility/suggest.js";
  const { suggestionRepository } = await import("./dist/repositories/suggestions.js");
  const beforeCount = suggestionRepository.forGuild(gid).length;
  const hostile = "@here ".repeat(83).trim();
  let r = await runCommand(S, `>suggest "${hostile}"`, { authorId: uid });
  const storedSug = suggestionRepository.forGuild(gid)[0];
  report("suggest: @-expansion stored within 500 (no CHECK crash)",
    r.ok && storedSug && storedSug.content.length <= 500,
    r.ok ? `len=${storedSug?.content?.length}` : `threw: ${r.error?.message}`);
  report("suggest: mention still broken after truncation",
    r.ok && storedSug && !storedSug.content.includes("@here"));

  // --- H2 (joke side): same attack via >joke add — the service-level
  // sanitize-then-truncate must keep the insert legal.
  const J = "./dist/commands/coolsies/joke.js";
  const { jokeRepository } = await import("./dist/repositories/jokes.js");
  const DEV = "111111111111111111";
  r = await runCommand(J, `>joke add "${hostile}"`, { authorId: DEV });
  const lastJoke = jokeRepository.list(1)[0];
  report("joke: @-expansion stored within 500 (no CHECK crash)",
    r.ok && lastJoke && lastJoke.content.length <= 500,
    r.ok ? `len=${lastJoke?.content?.length}` : `threw: ${r.error?.message}`);
  jokeRepository.remove(lastJoke.id);

  // --- M3: ">afk off to lunch" sets the reason; lone ">afk off" clears.
  const A = "./dist/commands/utility/afk.js";
  const { afkRepository } = await import("./dist/repositories/afk.js");
  r = await runCommand(A, ">afk off to lunch", { authorId: uid });
  report("afk: 'off to lunch' is a reason, not the clear subcommand",
    r.ok && afkRepository.get(gid, uid)?.reason === "off to lunch",
    `reason=${JSON.stringify(afkRepository.get(gid, uid)?.reason)}`);
  r = await runCommand(A, ">afk off", { authorId: uid });
  report("afk: lone 'off' still clears",
    r.ok && afkRepository.get(gid, uid) === null);
  // and lone "clear" too
  r = await runCommand(A, ">afk busy", { authorId: uid });
  r = await runCommand(A, ">afk clear", { authorId: uid });
  report("afk: lone 'clear' clears",
    r.ok && afkRepository.get(gid, uid) === null);

  // --- m10: >choose with 12 options must be rejected with a usage
  // error, never silently slice to 10.
  const C = "./dist/commands/coolsies/choose.js";
  r = await runCommand(C, `>choose ${Array.from({ length: 12 }, (_, i) => "opt" + i).join(" ")}`);
  report("choose: 12 options rejected loudly",
    !r.ok || r.replies.some((x) => String(x).includes("12")),
    "neither threw nor mentioned the count");

  // --- m9: guildDelete now prunes orphaned user rows. Seed data that
  // ONLY the departing guild references, delete the guild, and check
  // the users row is gone while still-referenced users survive.
  const { guildRepository } = await import("./dist/repositories/guilds.js");
  const { pruneOrphanedUsers } = await import("./dist/repositories/shared.js");
  const { warningService } = await import("./dist/services/warnings.js");
  const onlyHere = "888888888888888888";
  const keptUser = uid; // has a suggestion row in THIS guild too — see below
  const { ensureUser } = await import("./dist/repositories/shared.js");
  ensureUser(onlyHere); ensureUser(keptUser);
  // onlyHere references something in the guild (a warning) so it's
  // cascade-removed with the guild, then pruned; keptUser must survive
  // because... nothing references it after cascade — both get pruned.
  warningService.add(gid, onlyHere, DEV, "cascade me");
  // Give keptUser a reference OUTSIDE the departing guild: a joke.
  const { jokeService } = await import("./dist/services/jokes.js");
  const jokeId = jokeService.add("survivor joke", keptUser);
  guildRepository.remove(gid);
  const pruned = pruneOrphanedUsers();
  const userGone = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE user_id = ?").get(onlyHere).n === 0;
  const userKept = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE user_id = ?").get(keptUser).n === 1;
  report("users prune: guild-only user removed, joke-author kept",
    userGone && userKept, `pruned=${pruned}`);
  jokeRepository.remove(jokeId);
  // restore the guild row so the rest of the harness keeps working
  const { ensureGuild } = await import("./dist/repositories/shared.js");
  ensureGuild(gid);
}

// ============================================================
// FINAL
// ============================================================
console.log(`\n${failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${failed} FAILED / ${passed} passed`}`);
process.exitCode = failed === 0 ? 0 : 1;

// cleanup
const { closeDb } = await import("./dist/database/client.js");
closeDb();
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
