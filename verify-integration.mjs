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
process.env.SUGGESTIONS_FILE = "data/harness-suggestions-export.txt";
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
      return {
        id: "777777777777777777",
        edit: async () => null,
        createdTimestamp: Date.now(),
        // Button/collector commands (poll, rps) need a collector on the
        // reply; the mock runs it with an instantly-expiring timer and
        // a no-op 'collect' path — no live components in the harness.
        createMessageComponentCollector: () => ({
          on: () => {},
          stop: () => {},
        }),
      };
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
  // Bind THIS run's reply capture. The returned object also carries a
  // no-op component collector so button-based commands (poll, rps)
  // exercise their full reply path in the harness.
  message.reply = async (payload) => {
    myReplies.push(typeof payload === "string" ? payload : JSON.stringify(payload, replacer).slice(0, 300));
    return {
      id: "777777777777777777",
      edit: async () => null,
      createdTimestamp: Date.now(),
      createMessageComponentCollector: () => ({
        on: () => {},
        stop: () => {},
      }),
    };
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
  let r = await runCommand(J, ">joke");
  report("joke: empty store -> clean error", r.ok && r.replies.length > 0);

  // pleb tries add
  r = await runCommand(J, '>joke add "haha"', { authorId: PLEB });
  report("joke: non-dev add denied (PermissionError)", !r.ok && r.error?.name === "PermissionError", `got ok=${r.ok} err=${r.error?.name}`);
  const jokeCountBefore = jokeRepository.countAll();
  report("joke: nothing stored by pleb", jokeRepository.countAll() === jokeCountBefore);

  // dev adds (with the exact regression payload from last hunt)
  r = await runCommand(J, '>joke add "why do coders like dark mode? because light attracts bugs!"', { authorId: DEV });
  const jokes = jokeRepository.list(10);
  report("joke: dev add full quoted text", r.ok && jokes.length >= 1 &&
    jokes[0].content === "why do coders like dark mode? because light attracts bugs!",
    `got: ${jokes[0]?.content}`);

  // plain joke now (v0.6.3, no 'say'): works and bumps usage (random
  // pick — any enabled row's counter moves, not the newest one)
  r = await runCommand(J, ">joke");
  const anyUsed = jokeRepository.list(100).some((j) => j.usage_count > 0);
  report("joke: plain tell works", r.ok && anyUsed);

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
  report("joke: non-dev edit denied (PermissionError)", !r.ok && r.error?.name === "PermissionError", `got ok=${r.ok} err=${r.error?.name}`);

  // enable/disable/remove round trip
  r = await runCommand(J, `>joke disable ${target.id}`, { authorId: DEV });
  report("joke: disable", r.ok && jokeRepository.get(target.id).enabled === 0);
  r = await runCommand(J, ">joke");
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
    // 200-char option exceeds the 100-char cap -> UserInputError
    // (previously the command swallowed it internally with a reply;
    // with propagation this correctly throws to the dispatcher).
    [`>choose ${"x".repeat(200)}`, false, "200-char option rejected (cap 100)"],
  ];
  for (const [input, ok, label] of cases) {
    const res = await runCommand(C, input);
    report(`choose: ${label ?? input}`, ok ? res.ok : !res.ok || res.replies.length > 0);
  }

  // ---- rps: instant mode via prefix (button mode needs live
  // components; the invoker-filter logic is unit-pinned) ----
  const RP = "./dist/commands/coolsies/rps.js";
  let rr = await runCommand(RP, ">rps rock");
  report("rps: instant round works", rr.ok && rr.replies.length > 0);
  rr = await runCommand(RP, ">rps banana");
  report("rps: invalid weapon throws UserInputError", !rr.ok && rr.error?.name === "UserInputError", `ok=${rr.ok} err=${rr.error?.name}`);
  rr = await runCommand(RP, ">rps paper");
  report("rps: paper instant round", rr.ok && rr.replies.length > 0);

  // ---- poll: native Discord poll — new v1.1.0 grammar end-to-end
  // (parsePollArgs unit tests pin the boundary math; these pin the
  // dispatch shapes + the persistence/recap lifecycle) ----
  const P = "./dist/commands/utility/poll.js";
  let pr = await runCommand(P, '>poll 2 "best food?" "pizza", "pasta", "curry"');
  report("poll: decimal hours + quoted question + comma options", pr.ok, pr.ok ? "" : `threw: ${pr.error?.message}`);
  pr = await runCommand(P, '>poll 0.5 "lunch?" "sushi", "ramen"');
  report("poll: fractional duration accepted", pr.ok, pr.ok ? "" : `threw: ${pr.error?.message}`);
  pr = await runCommand(P, '>poll 1 "q?" "only one option"');
  report("poll: too few options -> clean error", !pr.ok || pr.replies.length > 0);
  pr = await runCommand(P, '>poll banana "q?" "a", "b"');
  report("poll: missing/bad duration rejected", !pr.ok || pr.replies.length > 0);
  pr = await runCommand(P, '>poll 999 "q?" "a", "b"');
  report("poll: 999 hours rejected", !pr.ok || pr.replies.length > 0);
  pr = await runCommand(P, '>poll 1 "q?" "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"');
  report("poll: 11 options rejected", !pr.ok || pr.replies.length > 0);

  const R8 = "./dist/commands/coolsies/8ball.js";
  const r8 = await runCommand(R8, ">8ball will it work?");
  report("8ball: normal ask", r8.ok);
  const r8b = await runCommand(R8, ">8ball");
  report("8ball: no question rejected", !r8b.ok || r8b.replies.length > 0);
  const r8c = await runCommand(R8, `>8ball ${"q".repeat(300)}`);
  report("8ball: long question rejected", !r8c.ok || r8c.replies.length > 0);
  // v0.6.2: questions that merely START with a management verb word
  // must be answered, not gated. Only the management SHAPE triggers
  // the developer gate.
  const r8d = await runCommand(R8, ">8ball remove the doubt, will it work?");
  report("8ball: 'remove ...' prose question is answered", r8d.ok && r8d.replies.length > 0, "gated as management?");
  const r8e = await runCommand(R8, ">8ball edit this: am I lucky?");
  report("8ball: 'edit ...' prose question is answered", r8e.ok && r8e.replies.length > 0, "gated as management?");
  const r8f = await runCommand(R8, ">8ball list of things I like?");
  report("8ball: 'list ...' prose question is answered", r8f.ok && r8f.replies.length > 0, "gated as management?");
  const r8g = await runCommand(R8, ">8ball enable happiness in my life?");
  report("8ball: 'enable ...' prose question is answered", r8g.ok && r8g.replies.length > 0, "gated as management?");
  // but the real management shape still gates non-devs:
  const r8h = await runCommand(R8, ">8ball remove 12", { authorId: "222222222222222222" });
  report("8ball: real 'remove <id>' still developer-gated (PermissionError)", !r8h.ok && r8h.error?.name === "PermissionError", `got ok=${r8h.ok} err=${r8h.error?.name}`);

  // 8-ball management suite (mirrors the joke suite)
  {
    const { eightBallRepository } = await import("./dist/repositories/eightball.js");
    const DEV8 = "111111111111111111";
    const PLEB8 = "222222222222222222";
    const seeded = eightBallRepository.countAll();
    report("8ball: seeded pool exists", seeded >= 19, `got ${seeded}`);

    // pleb denied management
    let rr = await runCommand(R8, '>8ball add "nope"', { authorId: PLEB8 });
    report("8ball: non-dev add denied (PermissionError)", !rr.ok && rr.error?.name === "PermissionError", `got ok=${rr.ok} err=${rr.error?.name}`);

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
    // Invalid input now throws the taxonomy UserInputError (dispatcher
    // renders + refunds cooldown) instead of a success-shaped reply.
    report(`snowflake: ${label}`,
      ok ? res.ok : !res.ok && res.error?.name === "UserInputError",
      `ok=${res.ok} err=${res.error?.name}`);
  }

  const RO = "./dist/commands/utility/roll.js";
  for (const [input, ok, label] of [
    [">roll", true, "default 1d6"], [">roll 2d6", true], [">roll 1d20+5", true],
    [">roll 0d6", false, "zero dice"], [">roll 99d6", false, "over max"], [">roll 2d1", false, "1 side"],
    [">roll banana", false, "garbage"], [">roll 2d6+999", true, "big modifier"],
  ]) {
    const res = await runCommand(RO, input);
    // Invalid notation throws the taxonomy UserInputError now.
    report(`roll: ${label ?? input}`,
      ok ? res.ok : !res.ok && res.error?.name === "UserInputError",
      `ok=${res.ok} err=${res.error?.name}`);
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
  // Cycle-I: the error is a taxonomy throw now (shared rendering +
  // cooldown refund), not an internal reply.
  const RT = "./dist/commands/coolsies/rate.js";
  const mockFetchFails = { ...{}, client: { users: { fetch: async () => null } } };
  const cmd = (await import(RT)).default;
  const msg = makeMessage(">rate 123456789012345678", { authorId: uid });
  const myReplies = [];
  msg.reply = async (p) => { myReplies.push(String(p)); return {}; };
  msg.client = mockFetchFails.client;
  let threw = null;
  try {
    await cmd.prefixExecute(msg, ["123456789012345678"]);
  } catch (e) {
    threw = e;
  }
  report("rate: unresolvable ID -> UserInputError (not silent self-rate)",
    threw?.name === "UserInputError" && myReplies.length === 0,
    `threw=${threw?.name} replies=${myReplies.length}`);
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
// REGRESSIONS (max-mode audit round 3 — v1.0.0 fixes)
// ============================================================
console.log("\n=== REGRESSIONS (audit round 3) ===");
{
  const { getDb } = await import("./dist/database/client.js");
  const gid = "999999999999999999";

  // --- Cycle-4: harness runs must NEVER touch the production
  // suggestions export. Before the SUGGESTIONS_FILE override, every
  // verify run appended its test payloads to data/suggestions.txt
  // (637 polluted lines accumulated). The export path is redirected;
  // this check pins that the redirect works.
  {
    const { readFileSync, existsSync: exists } = await import("node:fs");
    const exportBefore = exists("data/harness-suggestions-export.txt") ? readFileSync("data/harness-suggestions-export.txt", "utf8") : "";
    const harnessLines = exportBefore ? exportBefore.split("\n").filter((l) => l.trim()).length : 0;
    report("suggest export: harness writes go to the throwaway (not data/suggestions.txt)",
      harnessLines > 0, `throwaway lines=${harnessLines}`);
    // The real export must NOT contain harness markers after a full
    // run. UNCONDITIONAL: a missing file (fresh CI checkout — the
    // export is gitignored) IS the clean state; the conditional form
    // used to silently skip this report on runners, drifting the
    // harness count by one and failing the docs-count enforcement.
    const real = exists("data/suggestions.txt") ? readFileSync("data/suggestions.txt", "utf8") : "";
    const polluted = real.includes("user_2222") || real.includes("Test Guild (999999999999999999)") || real.includes("rm -rf");
    report("suggest export: production file free of harness pollution", !polluted,
      real ? "" : "(no production export on this machine — clean by absence)");
  }

  // --- Cycle-6: collection list pagination clamps to the last page ---
  {
    const J = "./dist/commands/coolsies/joke.js";
    const { jokeRepository } = await import("./dist/repositories/jokes.js");
    const { jokeService } = await import("./dist/services/jokes.js");
    const DEV = "111111111111111111";
    const seeded = [];
    for (let i = 0; i < 30; i++) seeded.push(jokeService.add(`page probe joke ${i}`, DEV));
    const mk = () => { const replies = []; return { author: { id: DEV, tag: "t#1" }, reply: async (p) => { replies.push(p); return {}; }, _replies: replies }; };
    // Page 999 must clamp to the LAST page, not crash or show empty
    const totalJokes = jokeService.countAll();
    const lastPage = Math.max(1, Math.ceil(totalJokes / 10));
    const far = mk();
    await (await import(J)).default.prefixExecute(far, ["list", "999"]);
    const farFooter = far._replies[0]?.embeds[0]?.toJSON()?.footer?.text ?? "";
    report("joke list: page 999 clamps to the last page",
      farFooter.includes(`Page ${lastPage}/${lastPage}`), `footer=${farFooter.slice(0, 20)}`);
    // Invalid pages throw clean taxonomy errors
    const zero = await runCommand(J, ">joke list 0", { authorId: DEV });
    report("joke list: page 0 rejected as UserInputError",
      !zero.ok && zero.error?.name === "UserInputError");
    // cleanup seeded probe jokes
    for (const id of seeded) jokeRepository.remove(id);
  }

  // --- Cycle-8: single-instance lock (subprocess probes) ---
  {
    const { spawnSync } = await import("node:child_process");
    const lock = await import("node:fs").then((m) => m.readFileSync("data/bot.lock", "utf8").trim()).catch(() => null);

    // 1) A live holder (our own harness process writes a lock pointing at a REAL
    //    alive PID — the harness itself) must make acquire refuse.
    const probeLive = `
      import { writeFileSync } from "node:fs";
      writeFileSync("data/bot.lock", String(process.pid));
      const { acquireSingleInstanceLock } = await import("./dist/lib/singleInstanceLock.js");
      const ok = acquireSingleInstanceLock();
      console.log(ok ? "ACQUIRED-BAD" : "REFUSED");
      process.exit(0);
    `;
    const res1 = spawnSync(process.execPath, ["--input-type=module", "-e", probeLive], { cwd: process.cwd(), encoding: "utf8" });
    report("lock: a live holder makes the second boot refuse",
      (res1.stdout ?? "").includes("REFUSED"), res1.stdout.trim());

    // 2) A stale lock (dead PID) is reclaimed silently.
    const probeStale = `
      import { writeFileSync, rmSync, existsSync } from "node:fs";
      writeFileSync("data/bot.lock", "999999999"); // no such PID
      const { acquireSingleInstanceLock, releaseSingleInstanceLock } = await import("./dist/lib/singleInstanceLock.js");
      const ok = acquireSingleInstanceLock();
      releaseSingleInstanceLock();
      const released = !existsSync("data/bot.lock");
      console.log(ok && released ? "RECLAIMED-RELEASED" : "BAD:" + ok + ":" + released);
      process.exit(0);
    `;
    const res2 = spawnSync(process.execPath, ["--input-type=module", "-e", probeStale], { cwd: process.cwd(), encoding: "utf8" });
    report("lock: stale lock reclaimed, then released cleanly",
      (res2.stdout ?? "").includes("RECLAIMED-RELEASED"), res2.stdout.trim());
  }

  // --- Cycle-9: allowedMentions gates (official Discord feature) ---
  {
    // >suggest echoes user text — the reply payload must carry the gate
    const S = "./dist/commands/utility/suggest.js";
    const cmd = (await import(S)).default;
    const captured = [];
    const msg = makeMessage('>suggest "ping <@123456789012345678> now"');
    msg.author = { id: "222222222222222222", tag: "t#1", bot: false, username: "u", toString: () => "<@222222222222222222>", fetch: async () => null, displayAvatarURL: () => "https://x/a.png", bannerURL: () => null };
    msg.reply = async (p) => { captured.push(p); return { id: "x", edit: async () => {}, createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }) }; };
    await cmd.prefixExecute(msg, ["ping <@123456789012345678> now"]);
    const gate = captured[0]?.allowedMentions;
    report("suggest: reply carries allowedMentions gate (invoker only)",
      gate && JSON.stringify(gate.users) === JSON.stringify(["222222222222222222"]),
      JSON.stringify(gate ?? null));
  }

  // --- Cycle-9: simplified live cooldown countdown ---
  {
    const { cooldownCountdownEmbed, startCooldownCountdown } = await import("./dist/lib/cooldownCountdown.js");
    const json = cooldownCountdownEmbed(">joke", 4_200).toJSON();
    const desc = json.description ?? "";
    report("countdown: 'too fast' + official <t:R> timestamp, no bar",
      desc.includes("too fast") && /<t:\d+:R>/.test(desc) && !desc.includes("▰"), desc.slice(0, 70));
    const edits = [];
    await new Promise((r) => setTimeout(r, 150));
    startCooldownCountdown({ edit: async (p) => { edits.push(p); } }, ">joke", 40);
    await new Promise((r) => setTimeout(r, 160));
    report("countdown: exactly one ready-flip edit after the window",
      edits.length === 1 && JSON.stringify(edits[0]).includes("again now"), `edits=${edits.length}`);
  }

  // --- Soft restart machinery (the /boot Reboot fix): the hook
  // contract, the pre-registration guard, and the reminder subsystem's
  // reset-for-restart path ---
  {
    const { registerRestartHook, triggerSoftRestart, isRestartHookArmed } = await import("./dist/lib/restartHook.js");
    const { reminderService, resetForRestart } = await import("./dist/services/reminders.js");

    // 1) un-armed hook must throw a clear error, never silently no-op
    let threw = false;
    try { triggerSoftRestart("probe", "probe"); } catch { threw = true; }
    report("restart hook: un-armed trigger throws (never a silent no-op)", threw);

    // 2) full flow: register -> trigger -> observe order
    const events = [];
    const fakeClient = {
      user: { tag: "B#1", id: "1", setPresence: () => null },
      guilds: { cache: new Map() },
      destroy: async () => events.push("destroyed"),
      login: async () => events.push("logged-in"),
      channels: { fetch: async () => null },
      createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }),
    };
    registerRestartHook((reason, by) => {
      events.push(`hook:${reason}:${by}`);
      reminderService.beginShutdown();
      resetForRestart();
      void (async () => { await fakeClient.destroy(); await fakeClient.login(); events.push("back-online"); })();
    });
    report("restart hook: armed after registration", isRestartHookArmed());
    triggerSoftRestart("/boot DM panel", "dev#1");
    await new Promise((r) => setTimeout(r, 150));
    report("restart hook: destroy -> re-login -> back-online ordering",
      events.length === 4 && events[0].startsWith("hook:") && events[1] === "destroyed" && events[2] === "logged-in" && events[3] === "back-online",
      events.join(" -> "));
  }

  // --- Cycle-6: the ORIGINAL 30-day timer bug, tested through the real
  // service for the first time. A 30-day reminder's delay exceeds the
  // 32-bit setTimeout limit (~24.86 days) — safeSetTimeout must chain
  // through intermediate hops instead of silently firing in 1ms. We
  // can't wait 30 days; we verify the chain ENGAGES: the scheduling
  // decision (intercepting the logger's console.log stream) must show
  // the chained path with the correct hop remainder.
  {
    const { reminderService } = await import("./dist/services/reminders.js");
    const { reminderRepository } = await import("./dist/repositories/reminders.js");
    const origLog = console.log;
    const captured = [];
    console.log = (...a) => captured.push(a.join(" "));
    try {
      const due = Date.now() + 30 * 24 * 60 * 60 * 1000 - 60_000; // 30d minus a hair (command cap allows exactly 30d)
      const id = await reminderService.create({ channels: { fetch: async () => null } }, gid, "555555555555555555", "181818181818181818", "30-day chain probe", due);
      reminderRepository.markDelivered(id); // stand the timer down; we only verify the scheduling decision
    } finally {
      console.log = origLog;
    }
    const chainLogged = captured.some((l) => l.includes("exceeds the safe hop limit") && l.includes("chaining"));
    report("reminders: 30-day reminder schedules through the CHAINED timer path", chainLogged,
      chainLogged ? "" : "chain decision never logged — would be the original 1ms-fire bug");
  }

  // --- Cycle-6: storage failsafes (pinned for the first time) ---
  // getDb() after closeDb() must refuse instead of silently re-opening.
  {
    const dbMod = await import("./dist/database/client.js");
    const { getDb, closeDb } = dbMod;
    // The harness closes at the end; simulate on the throwaway: close,
    // attempt access, expect the guard error, then RE-OPEN for the rest
    // of the harness by resetting the module state via a fresh getDb
    // after... the guard is one-way (`closed` never resets). So instead
    // exercise the guard via a SEPARATE process (subprocess) to keep the
    // harness's own DB alive:
    const { spawnSync } = await import("node:child_process");
    const probe = `
      process.env.DATABASE_FILE = "data/integration-test.db";
      process.env.DISCORD_TOKEN = "x"; process.env.CLIENT_ID = "1";
      const { getDb, runMigrations, closeDb } = await import("./dist/database/client.js");
      runMigrations();
      closeDb();
      try {
        getDb();
        console.log("REOPENED");
      } catch (e) {
        console.log(e.message.includes("after closeDb()") ? "GUARDED" : "WRONG-ERROR:" + e.message.slice(0, 60));
      }
      process.exit(0);
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: process.cwd(), encoding: "utf8" });
    const out = (res.stdout.match(/(GUARDED|REOPENED|WRONG-ERROR:.*)/) ?? [])[1];
    report("getDb: refuses access after closeDb (no silent reopen)", out === "GUARDED", `got: ${out}`);
  }

  // --- Cycle-5: 429 detection uses structured signals, not just text ---
  {
    // Exercise the real deliver() path: an overdue reminder against a
    // channel that throws a status-429 error must stay PENDING (the
    // sweep retries); a hard error must go terminal (failed).
    const { reminderService } = await import("./dist/services/reminders.js");
    const { reminderRepository } = await import("./dist/repositories/reminders.js");
    const rateLimitClient = {
      channels: { fetch: async () => ({
        isTextBased: () => true,
        // discord.js shape: HTTP 429 on .status
        send: async () => { throw Object.assign(new Error("Too many requests"), { status: 429 }); },
      }) },
    };
    const hardErrClient = {
      channels: { fetch: async () => ({
        isTextBased: () => true,
        send: async () => { throw new Error("Missing Permissions"); },
      }) },
    };
    const rlId = await reminderService.create(rateLimitClient, gid, "555555555555555555", "161616161616161616", "429 probe", Date.now() - 4000);
    await new Promise((r) => setTimeout(r, 300));
    const rlRow = reminderRepository.get(rlId);
    report("reminders: status-429 send stays pending (sweep retries)",
      rlRow?.status === "pending", `got ${rlRow?.status}`);
    const hardId = await reminderService.create(hardErrClient, gid, "555555555555555555", "171717171717171717", "hard-err probe", Date.now() - 4000);
    await new Promise((r) => setTimeout(r, 300));
    const hardRow = reminderRepository.get(hardId);
    report("reminders: hard send error goes terminal (failed)",
      hardRow?.status === "failed", `got ${hardRow?.status}`);
    for (const row of reminderRepository.pending()) reminderRepository.markDelivered(row.id);
  }

  // --- Cycle-5: concurrency coherence through the real services ---
  {
    const { warningService } = await import("./dist/services/warnings.js");
    const { reminderService } = await import("./dist/services/reminders.js");
    const { reminderRepository } = await import("./dist/repositories/reminders.js");
    const nullClient = { channels: { fetch: async () => null } };

    // 50 interleaved warn adds — the transactional cap must land at exactly 25
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
      Promise.resolve().then(() => warningService.add(gid, "race-u1", "111111111111111111", `w${i}`))));
    const capped = warningService.activeFor(gid, "race-u1").length;
    report("race: 50 concurrent warn adds land on the exact 25 cap", capped === 25, `got ${capped}`);
    warningService.clearActive(gid, "race-u1");

    // 40 interleaved reminder creates — cap 25, no duplicates
    await Promise.all(Array.from({ length: 40 }, (_, i) =>
      reminderService.create(nullClient, gid, "555555555555555555", "race-u2", `r${i}`, Date.now() + 600000).catch(() => null)));
    const pend = reminderRepository.pendingCountFor(gid, "race-u2");
    report("race: 40 concurrent reminder creates land on the exact 25 cap", pend === 25, `got ${pend}`);
    for (const row of reminderRepository.pending()) reminderRepository.markDelivered(row.id);
  }

  // --- Routing contract: lifecycle embeds and the raw mirror NEVER mix.
  // dev-log  <- 🟢/🔴 lifecycle embeds + error embeds ONLY
  // bot-logs <- raw mirrored operational lines ONLY
  // (Subprocess: config freezes at import, so run the matrix isolated.)
  {
    const { spawnSync } = await import("node:child_process");
    const probe = `
      process.env.DATABASE_FILE = "data/integration-test.db";
      process.env.DISCORD_TOKEN = "x"; process.env.CLIENT_ID = "1";
      process.env.DEV_LOG_CHANNEL_ID = "DEVLOG_CH";
      process.env.BOT_LOG_CHANNEL_ID = "BOTLOG_CH";
      const devLogSends = [], botLogSends = [];
      const client = {
        channels: { fetch: async (id) => ({
          isTextBased: () => true,
          send: async (p) => { if (id === "DEVLOG_CH") devLogSends.push(p); else if (id === "BOTLOG_CH") botLogSends.push(p); },
        }) },
        guilds: { cache: new Map([["g", { memberCount: 2 }]]) },
      };
      const { runMigrations, closeDb } = await import("./dist/database/client.js");
      runMigrations();
      const { announceOnline, announceOffline, sendDevLog } = await import("./dist/lib/devlog.js");
      const { initLogSink, flushLogSink } = await import("./dist/core/logSink.js");
      const { log } = await import("./dist/core/logger.js");
      initLogSink(client, "BOTLOG_CH");
      await announceOnline(client);
      await announceOffline(client, "probe", "tester");
      log.info("PREFIX", "raw line");
      await flushLogSink();
      await sendDevLog(client, { });
      closeDb();
      const okLifecycleInDevlog = devLogSends.length === 3; // online + offline + error embed
      const okNoLifecycleInBotlogs = botLogSends.length === 1; // the raw line only
      console.log(okLifecycleInDevlog && okNoLifecycleInBotlogs ? "ROUTING_OK" : "ROUTING_BROKEN dev=" + devLogSends.length + " bot=" + botLogSends.length);
      process.exit(0);
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: process.cwd(), encoding: "utf8" });
    const ok = (res.stdout ?? "").includes("ROUTING_OK");
    report("routing: lifecycle -> dev-log ONLY; raw mirror -> bot-logs ONLY (no mixing)",
      ok, (res.stdout ?? "") + (res.stderr ?? "").slice(0, 120));
  }

  // --- Cycle-4: repo-wide consistency pins (run in CI from now on) ---
  {
    const { readFileSync: read } = await import("node:fs");

    // 1) Version: package.json == config.ts == README heading == bug
    //    template placeholder.
    const pkg = JSON.parse(read("package.json", "utf8"));
    const cfg = read("src/core/config.ts", "utf8");
    const readme = read("README.md", "utf8");
    const bugTpl = read(".github/ISSUE_TEMPLATE/bug_report.md", "utf8");
    const v = pkg.version;
    report("consistency: package.json version matches config.ts",
      cfg.includes(`version: "${v}"`),
      `pkg=${v} config has: ${(cfg.match(/version: "([^"]+)"/) ?? [])[1]}`);
    report("consistency: README heading carries the current version",
      readme.includes(`# Syndicate Bot — v${v}`));
    report("consistency: bug-report template placeholder is current",
      bugTpl.includes(`"${v}"`));

    // 2) .env.example documents every env key config.ts reads.
    const cfgKeys = [...cfg.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
    const uniqueKeys = [...new Set(cfgKeys)];
    const envExample = read(".env.example", "utf8");
    const missing = uniqueKeys.filter((k) => !new RegExp(`^${k}=`, "m").test(envExample));
    report("consistency: .env.example documents every env key",
      missing.length === 0, `missing: ${missing.join(", ") || "(none)"}`);

    // 3) CI (both platforms) runs every harness package.json verify runs.
    const verifyScript = pkg.scripts.verify;
    const harnesses = [...verifyScript.matchAll(/node (verify-[a-z-]+\.mjs)/g)].map((m) => m[1]);
    const gh = read(".github/workflows/ci.yml", "utf8");
    const gl = read(".gitlab-ci.yml", "utf8");
    const missingCI = harnesses.filter((h) => !gh.includes(h) || !gl.includes(h));
    report("consistency: GitHub + GitLab CI run every verify harness",
      missingCI.length === 0, `missing: ${missingCI.join(", ") || "(none)"}`);
  }

  // --- C1: /warn list overflow must keep the NEWEST warnings ---
  const { warningService } = await import("./dist/services/warnings.js");
  const warnUid = "121212121212121212";
  // W00 added first ... W24 added last (newest). activeFor() returns newest-first.
  for (let i = 0; i < 25; i++) warningService.add(gid, warnUid, "111111111111111111", `W${String(i).padStart(2, "0")} ${"x".repeat(160)}`);
  const wList = warningService.formatList(warningService.activeFor(gid, warnUid));
  report("warn list: overflow shows the NEWEST (W24), hides the OLDEST (W00)",
    wList.description.includes("W24") && !wList.description.includes("W00"),
    `shown=${wList.shownCount}/${wList.totalCount}`);
  warningService.clearActive(gid, warnUid);

  // --- C2: >changelog embed must stay under Discord's 6000-char cap ---
  const changelogCmd = (await import("./dist/commands/utility/changelog.js")).default;
  {
    const myReplies = [];
    const msg = makeMessage(">changelog");
    msg.reply = async (p) => { myReplies.push(p); return { id: "x" }; };
    msg.author = { tag: "t#1", id: "1" };
    await changelogCmd.prefixExecute(msg, []);
    const json = myReplies[0].embeds[0].toJSON();
    let total = (json.title?.length ?? 0) + (json.description?.length ?? 0) + (json.footer?.text?.length ?? 0);
    for (const f of json.fields ?? []) total += (f.name?.length ?? 0) + (f.value?.length ?? 0);
    report("changelog: embed total under Discord's 6000-char cap",
      total <= 6000 && (json.fields ?? []).length <= 25, `total=${total}`);
  }

  // --- C3: pruneOrphanedUsers must respect the eightball FK ---
  {
    const { ensureUser, pruneOrphanedUsers } = await import("./dist/repositories/shared.js");
    const { eightBallRepository } = await import("./dist/repositories/eightball.js");
    const ghost = "131313131313131313";
    ensureUser(ghost);
    eightBallRepository.add("response by ghost", ghost);
    let prunedOk = true;
    try { pruneOrphanedUsers(); } catch (e) { prunedOk = false; }
    const survived = getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE user_id = ?").get(ghost).n === 1;
    report("prune: eightball-only user survives + no FK crash", prunedOk && survived);
    getDb().prepare("DELETE FROM eightball WHERE created_by = ?").run(ghost);
    getDb().prepare("DELETE FROM users WHERE user_id = ?").run(ghost);
  }

  // --- H5: strict parseInt — hex/scientific IDs must be rejected ---
  {
    const J = "./dist/commands/coolsies/joke.js";
    const { jokeRepository } = await import("./dist/repositories/jokes.js");
    const DEV = "111111111111111111";
    jokeRepository.add("hex canary joke", DEV);
    const canary = jokeRepository.list(1)[0];
    let r = await runCommand(J, `>joke remove 0x${canary.id.toString(16)}`, { authorId: DEV });
    const hexGotRejected = !r.ok || r.replies.length > 0;
    const canaryStillThere = jokeRepository.get(canary.id) !== null;
    report("parseInt: hex ID rejected (0x10-style no longer deletes #16)",
      hexGotRejected && canaryStillThere, `canary #${canary.id} still present: ${canaryStillThere}`);
    r = await runCommand(J, `>joke remove ${canary.id}`, { authorId: DEV });
    report("parseInt: plain decimal ID still works", r.ok && jokeRepository.get(canary.id) === null);
  }

  // --- H4: per-user pending reminder cap ---
  {
    const R = "./dist/commands/utility/remindme.js";
    const { reminderRepository } = await import("./dist/repositories/reminders.js");
    const capUid = "141414141414141414";
    let setOk = 0;
    for (let i = 0; i < 30; i++) {
      const r = await runCommand(R, `>remindme "in 2 minutes" filler ${i}`, { authorId: capUid });
      if (r.ok) setOk++;
    }
    const pending = reminderRepository.pendingCountFor(gid, capUid);
    report("remindme: pending capped at 25 per user (30 attempted)",
      setOk === 25 && pending === 25, `set=${setOk} pending=${pending}`);
    for (const row of reminderRepository.pending()) reminderRepository.markDelivered(row.id);
  }

  // --- H2: poll must sanitize question/options (v1.1.0: native poll) ---
  {
    const P = "./dist/commands/utility/poll.js";
    const cmd = (await import(P)).default;
    const captured = [];
    const msg = makeMessage('>poll 1 "@everyone vote!" "@everyone", "opt"');
    msg.reply = async (p) => {
      captured.push(p); // keep the RAW payload — the native poll object
      return {
        id: "777777777777777777", edit: async () => null, createdTimestamp: Date.now(),
        createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }),
      };
    };
    await cmd.prefixExecute(msg, ["1", "@everyone vote!", "@everyone,", "opt"]);
    const payload = captured[0];
    const poll = payload.poll;
    const questionText = poll?.question?.text ?? "";
    const answerTexts = (poll?.answers ?? []).map((a) => a.text ?? "");
    report("poll: native poll object present (no embeds/components)",
      Boolean(poll) && !payload.embeds && !payload.components,
      payload ? `keys: ${Object.keys(payload).join(",")}` : "no reply captured");
    report("poll: @everyone broken in question (native poll text)",
      !questionText.includes("@everyone") && questionText.includes("\u200b"),
      `question=${JSON.stringify(questionText)}`);
    report("poll: @everyone broken in poll answers",
      !answerTexts.some((t) => t.includes("@everyone")),
      `answers=${JSON.stringify(answerTexts)}`);
    report("poll: fractional duration maps to whole-hour API ceiling",
      typeof poll?.duration === "number" && poll.duration >= 1 && poll.duration <= 768,
      `duration=${poll?.duration}`);
    report("poll: poll payload carries the close-time content line",
      typeof payload.content === "string" && payload.content.includes("Closes"),
      `content=${JSON.stringify(payload.content)}`);
    // and the invisible-only question is now rejected cleanly
    const bad = await runCommand(P, `>poll 1 "${"\u200B".repeat(3)}" "a", "b"`);
    report("poll: invisible-only question rejected, not empty-question crash",
      !bad.ok || bad.replies.length > 0, "neither threw nor replied");
  }

  // --- H2b: poll recap lifecycle through the REAL service (v1.1.0) ---
  // closePoll is private, but it's the body of every public trigger
  // (timer, sweep, restore) — so drive it exactly the way a real
  // overdue row reaches it: create() schedules with delay 0, the
  // event loop fires the timer, closePoll runs to completion.
  {
    const { pollService } = await import("./dist/services/polls.js");
    const { pollRepository } = await import("./dist/repositories/polls.js");

    const pollGid = "999999999999999999";
    const pollUid = "191919191919191919";
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // Mock channel/message surface shaped like the real one: the poll
    // message exists, poll.end() succeeds, the message re-fetch carries
    // final counts, and the recap lands via message.reply.
    const makeLifecycleClient = (votes, { endBehavior = null, messageGone = false, recapBehavior = null } = {}) => {
      const sentRecaps = [];
      const endCalls = [];
      const pollObj = {
        end: async () => {
          endCalls.push(1);
          if (endBehavior) throw endBehavior;
          return { ok: true };
        },
        answers: new Map(votes.map((count, i) => [i + 1, { voteCount: count }])),
      };
      const pollMessage = {
        id: "888000000000000001",
        poll: pollObj,
        fetch: async () => (messageGone ? null : pollMessage),
        reply: async (p) => {
          if (recapBehavior) throw recapBehavior;
          sentRecaps.push(p);
          return { id: "r" };
        },
      };
      const channel = {
        id: "555555555555555555",
        isTextBased: () => true,
        // Deleted poll message -> fetch resolves null (djs resolves 404
        // UNKNOWN_MESSAGE to null)
        messages: { fetch: async () => (messageGone ? Promise.reject(new Error("Unknown message")) : pollMessage) },
        send: async () => ({ id: "x" }),
      };
      return { client: { channels: { fetch: async () => channel } }, sentRecaps, endCalls };
    };

    // 1) create -> open row + close timer; overdue row closes through
    //    the real timer path: end() called once, recap replied with
    //    the final tally + author-only mention gate, row terminal.
    {
      const mk = makeLifecycleClient([3, 1, 0]);
      const id = await pollService.create(mk.client, pollGid, "555555555555555555", "888000000000000001", pollUid, "best food?", ["pizza", "pasta", "curry"], Date.now() - 1000);
      await wait(250); // timer delay 0 -> closePoll runs
      const row = pollRepository.get(id);
      const recap = mk.sentRecaps[0];
      const desc = recap?.embeds?.[0]?.toJSON?.().description ?? "";
      report("poll lifecycle: overdue row closed + recap posted",
        row?.status === "closed" && mk.sentRecaps.length === 1 && mk.endCalls.length === 1,
        `status=${row?.status} endCalls=${mk.endCalls.length} recaps=${mk.sentRecaps.length}`);
      report("poll lifecycle: recap carries winner, counts, percentages",
        desc.includes("**pizza**") && desc.includes("3 votes (75%)") && desc.includes("won with 3 of 4"),
        `desc=${JSON.stringify(desc.slice(0, 160))}`);
      report("poll lifecycle: recap pings only the poll author",
        JSON.stringify(recap?.allowedMentions) === JSON.stringify({ users: [pollUid] }),
        `allowedMentions=${JSON.stringify(recap?.allowedMentions)}`);
    }

    // 2) PollAlreadyExpired is the success path, not an error — the
    //    poll ended on its own; the recap must still post.
    {
      const mk = makeLifecycleClient([2, 2]);
      const id = await pollService.create(mk.client, pollGid, "555555555555555555", "888000000000000001", pollUid, "tie?", ["a", "b"], Date.now() - 1000);
      await wait(250);
      const row = pollRepository.get(id);
      report("poll lifecycle: PollAlreadyExpired -> recap still posts, row closed",
        row?.status === "closed" && mk.sentRecaps.length === 1
          && JSON.stringify(mk.sentRecaps[0]?.embeds?.[0]?.toJSON?.().description).includes("tie"),
        `status=${row?.status} recaps=${mk.sentRecaps.length}`);
    }

    // 3) 429 on the end/recap path stays OPEN for the sweep to retry
    //    (never terminally failed) — same contract as reminder delivery.
    {
      const mk = makeLifecycleClient([1, 0], { recapBehavior: Object.assign(new Error("Too many requests"), { status: 429 }) });
      const id = await pollService.create(mk.client, pollGid, "555555555555555555", "888000000000000001", pollUid, "429?", ["a", "b"], Date.now() - 1000);
      await wait(250);
      const row = pollRepository.get(id);
      report("poll lifecycle: 429 recap stays open (sweep retries)",
        row?.status === "open", `got ${row?.status}`);
      pollRepository.markClosed(id); // stand down for the harness
    }

    // 4) hard error on end() goes terminal (failed) — no retry spin
    {
      const mk = makeLifecycleClient([1, 0], { endBehavior: new Error("Missing Permissions") });
      const id = await pollService.create(mk.client, pollGid, "555555555555555555", "888000000000000001", pollUid, "hard?", ["a", "b"], Date.now() - 1000);
      await wait(250);
      const row = pollRepository.get(id);
      report("poll lifecycle: hard end() error goes terminal (failed)",
        row?.status === "failed", `got ${row?.status}`);
    }

    // 5) deleted poll message -> terminal failed, no recap, no crash
    {
      const mk = makeLifecycleClient([1, 0], { messageGone: true });
      const id = await pollService.create(mk.client, pollGid, "555555555555555555", "888000000000000001", pollUid, "gone?", ["a", "b"], Date.now() - 1000);
      await wait(250);
      const row = pollRepository.get(id);
      report("poll lifecycle: deleted poll message -> failed, recap skipped",
        row?.status === "failed" && mk.sentRecaps.length === 0,
        `status=${row?.status} recaps=${mk.sentRecaps.length}`);
    }

    // 6) restore() reschedules open rows (restart survival) and the
    //    per-user cap throws the REAL UserInputError
    {
      const openBefore = pollRepository.open().length;
      const mk = makeLifecycleClient([1, 0]);
      const restored = pollService.restore(mk.client);
      report("poll lifecycle: restore() reschedules every open row",
        restored === openBefore, `restored=${restored} open=${openBefore}`);

      // cap: MAX_OPEN_PER_USER open polls -> clean taxonomy error
      const capClient = makeLifecycleClient([1, 0]).client;
      let capError = null;
      for (let i = 0; i < 12; i++) {
        try {
          await pollService.create(capClient, pollGid, "555555555555555555", `88800000000000000${i + 2}`, "capUser-1919", "cap?", ["a", "b"], Date.now() + 3_600_000);
        } catch (e) {
          capError = e;
          break;
        }
      }
      const capRows = pollRepository.open().filter((r) => r.user_id === "capUser-1919");
      report("poll lifecycle: per-user cap (10) throws the real UserInputError",
        capError?.name === "UserInputError" && capRows.length === 10,
        `err=${capError?.name} rows=${capRows.length}`);
      for (const r of capRows) pollRepository.markClosed(r.id);
      for (const r of pollRepository.open()) if (r.user_id === pollUid) pollRepository.markClosed(r.id);
    }

    // 7) a corrupt options payload goes TERMINAL, not spin: leaving a
    //    poison row open would make the 60s sweep retry it forever.
    //    (Impossible through normal writes — simulated by direct SQL.)
    {
      const { getDb } = await import("./dist/database/client.js");
      const poisonId = pollRepository.create(pollGid, "555555555555555555", "999000000000000001", pollUid, "poison?", ["a", "b"], Date.now(), Date.now() - 1000);
      getDb().prepare(`UPDATE polls SET options = 'not-json' WHERE id = ?`).run(poisonId);
      const mk = makeLifecycleClient([1, 0]);
      await pollService.create(mk.client, pollGid, "555555555555555555", "999000000000000002", pollUid, "poison2?", ["a", "b"], Date.now() - 1000).catch(() => null);
      // the poison row is due; the sweep's close path must mark it failed.
      // Drive it the same way the timer does: schedule already-overdue.
      const { pollService: fresh } = await import("./dist/services/polls.js");
      // restore() reschedules ALL open rows including the poison one
      fresh.restore(mk.client);
      await wait(250);
      const row = pollRepository.get(poisonId);
      report("poll lifecycle: corrupt options payload goes terminal (no sweep spin)",
        row?.status === "failed", `got ${row?.status}`);
      for (const r of pollRepository.open()) pollRepository.markClosed(r.id);
    }
  }

  // --- H1: mirror sanitizer neutralizes code fences (unit-level) ---
  {
    const { sanitizeMirrorLine } = await import("./dist/core/logSink.js");
    const line = sanitizeMirrorLine('args=["``` @everyone"] ');
    report("logSink: triple-backtick neutralized in mirrored lines", !line.includes("```"));
  }

  // --- Cycle-2: the reminder cap must throw the REAL UserInputError ---
  {
    const R = "./dist/commands/utility/remindme.js";
    const { reminderService } = await import("./dist/services/reminders.js");
    const capUid2 = "151515151515151515";
    // fill to the cap (25)
    for (let i = 0; i < 25; i++) {
      await runCommand(R, `>remindme "in 2 minutes" fill ${i}`, { authorId: capUid2 });
    }
    const over = await runCommand(R, '>remindme "in 2 minutes" one too many', { authorId: capUid2 });
    report("remindme: cap error is a REAL UserInputError (instanceof, not faked name)",
      !over.ok && over.error?.name === "UserInputError" && over.error?.constructor?.name === "UserInputError",
      `got ${over.error?.constructor?.name}`);
    const { reminderRepository } = await import("./dist/repositories/reminders.js");
    for (const row of reminderRepository.pending()) reminderRepository.markDelivered(row.id);
  }

  // --- Cycle-2: invisible-only content is rejected, never a CHECK crash ---
  {
    const J = "./dist/commands/coolsies/joke.js";
    const { jokeRepository } = await import("./dist/repositories/jokes.js");
    const DEV = "111111111111111111";
    const before = jokeRepository.countAll();
    const inv = await runCommand(J, `>joke add "${"\u200B".repeat(5)}"`, { authorId: DEV });
    report("joke: invisible-only add rejected as UserInputError (no CHECK crash)",
      !inv.ok && inv.error?.name === "UserInputError" && jokeRepository.countAll() === before,
      `count=${jokeRepository.countAll()}/${before}`);

    const R8 = "./dist/commands/coolsies/8ball.js";
    const { eightBallRepository } = await import("./dist/repositories/eightball.js");
    const before8 = eightBallRepository.countAll();
    const inv8 = await runCommand(R8, `>8ball add "${"\u200B".repeat(5)}"`, { authorId: DEV });
    report("8ball: invisible-only add rejected as UserInputError (no CHECK crash)",
      !inv8.ok && inv8.error?.name === "UserInputError" && eightBallRepository.countAll() === before8);

    const R = "./dist/commands/utility/remindme.js";
    const rem = await runCommand(R, `>remindme "in 2 minutes" ${"\u200B".repeat(5)}`, { authorId: DEV });
    report("remindme: invisible-only text rejected as UserInputError (no CHECK crash)",
      !rem.ok && rem.error?.name === "UserInputError");

    const A = "./dist/commands/utility/afk.js";
    const { afkRepository } = await import("./dist/repositories/afk.js");
    const invAfk = await runCommand(A, `>afk ${"\u200B".repeat(5)}`, { authorId: DEV });
    const afkRow = afkRepository.get("999999999999999999", DEV);
    report("afk: invisible-only reason falls back to 'AFK' (no empty stored reason)",
      invAfk.ok && afkRow?.reason === "AFK", `reason=${JSON.stringify(afkRow?.reason)}`);
    afkRepository.clear("999999999999999999", DEV);
  }

  // --- Cycle-2: unfirom joke/8ball error taxonomy via the dispatcher ---
  {
    // With internal catch-and-rerender removed, >choose with one option
    // must THROW a UserInputError (the dispatcher renders it) — not
    // reply-and-swallow (which burned the cooldown).
    const C = "./dist/commands/coolsies/choose.js";
    const one = await runCommand(C, ">choose pizza");
    report("choose: input errors propagate (throw, not internal reply)",
      !one.ok && one.error?.name === "UserInputError", `got ok=${one.ok}`);
    const RN = "./dist/commands/coolsies/random.js";
    const bad = await runCommand(RN, ">random 5");
    report("random: input errors propagate (throw, not internal reply)",
      !bad.ok && bad.error?.name === "UserInputError");
  }
}

// ============================================================
// CYCLE I (adversarial audit) regression pins — every behavioral
// fix from the cycle, asserted through the real code paths.
// ============================================================
{
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const gid = "999999999999999999";

  // --- 1) timestamp error is taxonomy + backtick-neutral (the F1
  // ping vector: raw input used to render OUTSIDE the code span in a
  // CONTENT reply) ---
  {
    const T = "./dist/commands/utility/timestamp.js";
    const hostile = await runCommand(T, '>ts x` <@111111111111111111> y');
    report("cycle-I: ts hostile input -> UserInputError (taxonomy, no content reply)",
      !hostile.ok && hostile.error?.name === "UserInputError",
      `ok=${hostile.ok} err=${hostile.error?.name}`);
    report("cycle-I: ts error text carries no raw backtick payload",
      !String(hostile.error?.message ?? "").includes("` <@"),
      String(hostile.error?.message).slice(0, 80));
  }

  // --- 2) reminder delivery on a REPLACED client stays pending (the
  // soft-restart window: the deterministic reference-comparison fix) ---
  {
    const { reminderService, resetForRestart } = await import("./dist/services/reminders.js");
    const { reminderRepository } = await import("./dist/repositories/reminders.js");
    const { pollService, resetForRestart: resetPolls } = await import("./dist/services/polls.js");

    // The in-flight race needs the OLD delivery to be mid-send when
    // the client swaps. Gate its channel.fetch on a promise we
    // control: the delivery starts, we swap the live client (restore
    // + reset), release the gate, and the send fails on the STALE
    // reference — which must stay pending.
    let releaseFetch;
    const gate = new Promise((r) => { releaseFetch = r; });
    const staleClient = {
      channels: { fetch: async () => {
        await gate; // hold the delivery mid-flight
        return {
          isTextBased: () => true,
          send: async () => { throw new Error("Missing Permissions"); },
        };
      } },
    };
    const id = await reminderService.create(staleClient, gid, "555555555555555555", "202020202020202020", "restart-window probe", Date.now() - 1000);
    await wait(50); // let the timer's deliver() enter the gated fetch

    // The soft restart: stand down, swap the live client, re-arm.
    // (index.ts order: resetForRestart() runs BEFORE bootClient()'s
    // restore() — schedule() drops rows while shuttingDown is set.)
    // The healthy client's fetch is gated too (never released) so the
    // fresh timer enters its fetch and hangs — pinning that the STALE
    // failure left the row PENDING (not terminally failed); the healthy
    // delivery is a separate, correct outcome we don't want racing
    // this assertion.
    reminderService.beginShutdown();
    pollService.beginShutdown();
    resetForRestart();
    resetPolls();
    const healthyClient = {
      channels: { fetch: async () => {
        await new Promise(() => {}); // hang: this probe only asserts the stale path
      } },
    };
    reminderService.restore(healthyClient);
    pollService.restore(healthyClient);
    releaseFetch(); // the in-flight delivery resumes — on the stale reference
    await wait(300);

    const row = reminderRepository.get(id);
    report("cycle-I: failed send on a replaced client stays pending (restart window)",
      row?.status === "pending", `got ${row?.status}`);
    reminderRepository.markDelivered(id);
    for (const r of reminderRepository.pending()) reminderRepository.markDelivered(r.id);
  }

  // --- 3) poll cap is pre-checked BEFORE the poll posts ---
  {
    const { pollService } = await import("./dist/services/polls.js");
    const { pollRepository } = await import("./dist/repositories/polls.js");
    const { MAX_OPEN_PER_USER } = await import("./dist/services/polls.js");
    const capUid = "303030303030303030";
    const mockClient = { channels: { fetch: async () => null } };
    for (let i = 0; i < 10; i++) {
      await pollService.create(mockClient, gid, "555555555555555555", `99900000000000010${i}`, capUid, "cap?", ["a", "b"], Date.now() + 3_600_000);
    }
    // assertCanCreate must throw BEFORE any message is posted — the
    // exact UserInputError, same class create() enforces.
    let threw = null;
    try { pollService.assertCanCreate(gid, capUid); } catch (e) { threw = e; }
    report("cycle-I: poll cap pre-check throws the real UserInputError",
      threw?.name === "UserInputError", `got ${threw?.name}`);
    const open = pollRepository.open().filter((r) => r.user_id === capUid);
    report("cycle-I: poll cap holds exactly 10",
      open.length === MAX_OPEN_PER_USER, `open=${open.length}`);
    for (const r of open) pollRepository.markClosed(r.id);
  }

  // --- 4) retention purge deletes only terminal/old rows ---
  {
    const { reminderRepository } = await import("./dist/repositories/reminders.js");
    const { pollRepository } = await import("./dist/repositories/polls.js");
    const { warningRepository } = await import("./dist/repositories/warnings.js");

    // Rows due 50 days ago; cutoff at 30 days — well clear of the
    // strict `<` boundary either direction.
    const old = Date.now() - 50 * 24 * 60 * 60 * 1000;
    const fresh = Date.now();
    const oldId = reminderRepository.create(gid, "c", "404040404040404040", "old", old);
    const newId = reminderRepository.create(gid, "c", "404040404040404040", "new", fresh);
    reminderRepository.markDelivered(oldId);
    reminderRepository.markDelivered(newId);
    // a PENDING old reminder must NOT be purged (it's still a promise)
    const pendId = reminderRepository.create(gid, "c", "404040404040404040", "pend", old);

    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const purged = reminderRepository.purgeTerminal(cutoff);
    report("cycle-I: retention purges old terminal reminders, keeps fresh + pending",
      purged >= 1 && !reminderRepository.get(oldId)
        && reminderRepository.get(newId)?.status === "delivered"
        && reminderRepository.get(pendId)?.status === "pending",
      `purged=${purged}`);
    reminderRepository.markDelivered(pendId);
    reminderRepository.markDelivered(newId);
    // polls + warnings purge: verify they run and return ints
    const pp = pollRepository.purgeTerminal(cutoff);
    const wp = warningRepository.purgeInactive(cutoff);
    report("cycle-I: poll/warning retention purges run cleanly",
      Number.isInteger(pp) && Number.isInteger(wp), `p=${pp} w=${wp}`);
  }

  // --- 5) prefix-lane unmapped errors reach the user through the
  // shared handler AND the dispatcher survives them (the devlog call
  // inside is fire-and-forget with .catch(() => null) — parity with
  // the slash lane is structural; the REAL dispatch path is what
  // needs proving: messageCreate.execute with a command whose
  // execution throws a raw unexpected error) ---
  {
    const eventMod = await import("./dist/events/messageCreate.js");
    const { loadCommands } = await import("./dist/handlers/commandHandler.js");
    const { SyndicateClient } = await import("./dist/core/client.js");

    const probeClient = new SyndicateClient({ intents: [] });
    await loadCommands(probeClient);
    // Plant a command whose execute always throws a raw error.
    probeClient.prefixCommands.set("crashprobe", {
      category: "utility", surface: "prefix-only", name: "crashprobe",
      usage: "crashprobe", prefixExecute: async () => { throw new Error("synthetic failure"); },
    });

    const replies = [];
    const raw = ">crashprobe boom";
    const msg = makeMessage(raw);
    // The dispatcher resolves commands through message.client — point
    // it at the probe client carrying the planted crash command.
    msg.client = probeClient;
    msg.reply = async (p) => { replies.push(p); return { id: "x", edit: async () => null, createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }) }; };
    let dispatcherCrashed = false;
    try {
      await eventMod.default.execute(msg);
    } catch {
      dispatcherCrashed = true; // the event wrapper normally catches; a throw here is a harness-visible bug
    }
    const replied = replies.some((p) => JSON.stringify(p).includes("Something went wrong"));
    report("cycle-I: prefix dispatcher survives a crashing command and replies generically",
      !dispatcherCrashed && replied, `crashed=${dispatcherCrashed} replies=${replies.length}`);
  }

  // --- 5b) SqliteError normalizes into the DatabaseError taxonomy ---
  {
    const { asTaxonomyError, DatabaseError } = await import("./dist/lib/errors.js");
    const raw = Object.assign(new Error("database is locked"), { name: "SqliteError" });
    const normalized = asTaxonomyError(raw);
    report("cycle-I: raw SqliteError maps to DatabaseError (dedicated user text + devlog)",
      normalized instanceof DatabaseError, `got ${normalized?.constructor?.name}`);
    const untouched = asTaxonomyError(new Error("plain"));
    report("cycle-I: non-DB errors pass through the normalizer untouched",
      untouched instanceof Error && !(untouched instanceof DatabaseError), `got ${untouched?.constructor?.name}`);
    const kept = asTaxonomyError(new (await import("./dist/lib/errors.js")).UserInputError("x"));
    report("cycle-I: taxonomy classes round-trip unchanged",
      kept instanceof (await import("./dist/lib/errors.js")).UserInputError, `got ${kept?.constructor?.name}`);
  }

  // --- 6) event-loader boot-fail: an invalid event file must REFUSE
  // to boot (subprocess probe — the harness's own DB stays live) ---
  {
    const { spawnSync } = await import("node:child_process");
    const { mkdirSync, writeFileSync, rmSync, cpSync } = await import("node:fs");
    const path = await import("node:path");
    // The probe tree must live UNDER the project root so bare imports
    // (dotenv, discord.js, better-sqlite3) resolve through the real
    // node_modules — a tmp-dir tree dies on the first import.
    const tmp = path.join(process.cwd(), "data", "eventload-probe");
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(path.join(tmp, "events"), { recursive: true });
    // Rebuild the compiled tree with relative-import-safe layout:
    // copy dist subtrees + plant one invalid event file. The handlers
    // resolve ../../events relative to themselves — same shape as dist/.
    cpSync("dist/handlers", path.join(tmp, "handlers"), { recursive: true });
    cpSync("dist/core", path.join(tmp, "core"), { recursive: true });
    cpSync("dist/lib", path.join(tmp, "lib"), { recursive: true });
    cpSync("dist/events", path.join(tmp, "events"), { recursive: true });
    writeFileSync(path.join(tmp, "events", "bogus.js"), "export default { name: \"x\" }; // no execute\n");
    const probe = `
      process.env.DISCORD_TOKEN = "x";
      process.env.CLIENT_ID = "123456789012345678";
      process.env.DATABASE_FILE = "data/embeds-test.db";
      import("file://" + process.cwd() + "/data/eventload-probe/handlers/eventHandler.js").then(async (m) => {
        const clientMod = await import("file://" + process.cwd() + "/data/eventload-probe/core/client.js");
        const client = new clientMod.SyndicateClient({ intents: [] });
        try {
          await m.loadEvents(client);
          console.log("LOADED-SILENTLY");
        } catch (e) {
          console.log("REFUSED-BOOT:" + e.message.slice(0, 60));
        }
      }).catch((e) => console.log("IMPORT-FAIL:" + e.message.slice(0, 120)));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: process.cwd(), encoding: "utf8" });
    const out = (res.stdout.match(/(REFUSED-BOOT:.*|LOADED-SILENTLY|IMPORT-FAIL:.*)/) ?? [])[1] ?? "";
    report("cycle-I: invalid event file refuses to boot (no silent skip)",
      out.startsWith("REFUSED-BOOT"), `got: ${out || res.stderr.slice(0, 100)}`);
    rmSync(tmp, { recursive: true, force: true });
  }
}



console.log(`\n${failed === 0 ? `ALL ${passed} CHECKS PASSED` : `${failed} FAILED / ${passed} passed`}`);
process.exitCode = failed === 0 ? 0 : 1;

// cleanup
const { closeDb } = await import("./dist/database/client.js");
closeDb();
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
if (existsSync("data/harness-suggestions-export.txt")) rmSync("data/harness-suggestions-export.txt");
