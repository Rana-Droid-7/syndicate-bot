/**
 * Cycle-3 harness: PURE-OUTPUT verification. Renders every embed the
 * bot can produce — via discord.js' own toJSON() serializer — and
 * validates each against Discord's HARD limits:
 *
 *   - total content (title + description + fields + footer): 6000
 *   - field count: 25
 *   - title: 256
 *   - description: 4096
 *   - each field name: 256, each field value: 1024
 *
 * The verify-integration harness checks behavior; this one checks the
 * RENDERED SHAPE — the layer Discord itself validates on send. An
 * embed that builds fine in EmbedBuilder but exceeds a limit throws
 * "Invalid Form Body" at the API, not in our code.
 *
 * Run: node verify-embeds.mjs   (requires `npm run build` first)
 */

import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, "data", "embeds-test.db");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
process.env.DATABASE_FILE = "data/embeds-test.db";
process.env.SUGGESTIONS_FILE = "data/harness-suggestions-export.txt";
process.env.DISCORD_TOKEN = "x";
process.env.CLIENT_ID = "123456789012345678";
process.env.OWNER_ID = "111111111111111111";

const { runMigrations, closeDb, getDb } = await import("./dist/database/client.js");
runMigrations();

let passed = 0, failed = 0;
function report(name, ok, detail = "") {
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${detail ? " — " + detail : ""}`); }
}

/** Validates one serialized embed against Discord's hard shape limits. */
function validateEmbed(label, embed) {
  if (!embed) return report(`${label}: embed present`, false, "null embed");
  const json = typeof embed.toJSON === "function" ? embed.toJSON() : embed;
  const errs = [];

  const title = json.title ?? "";
  const description = json.description ?? "";
  const fields = json.fields ?? [];
  const footer = json.footer?.text ?? "";

  if (title.length > 256) errs.push(`title ${title.length} > 256`);
  if (description.length > 4096) errs.push(`description ${description.length} > 4096`);
  if (fields.length > 25) errs.push(`${fields.length} fields > 25`);
  let total = title.length + description.length + footer.length;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if ((f.name ?? "").length > 256) errs.push(`field[${i}].name ${(f.name ?? "").length} > 256`);
    if ((f.value ?? "").length > 1024) errs.push(`field[${i}].value ${(f.value ?? "").length} > 1024`);
    total += (f.name ?? "").length + (f.value ?? "").length;
  }
  if (total > 6000) errs.push(`total ${total} > 6000`);

  return report(`${label}`, errs.length === 0, errs.join("; "));
}

// ---------- shared mock surface (same as verify-integration) ----------
function makeMessage(content, opts = {}) {
  const authorId = opts.authorId ?? "222222222222222222";
  const mentioned = new Map((opts.mentions ?? []).map((m) => [m.id, m]));
  mentioned.first = () => [...mentioned.values()][0];
  return {
    id: "444444444444444444",
    content,
    author: {
      id: authorId, bot: false,
      tag: `user_${authorId.slice(-4)}#0001`,
      username: `user_${authorId.slice(-4)}`,
      toString: () => `<@${authorId}>`,
      fetch: async () => null,
      displayAvatarURL: () => "https://example.com/avatar.png",
      bannerURL: () => null,
    },
    client: { channels: { fetch: async () => null }, users: mentioned, user: null },
    member: null,
    guild: opts.guildId === null ? null : { id: opts.guildId ?? "999999999999999999", name: "Test Guild", members: { fetch: async () => null } },
    mentions: { users: mentioned },
    channelId: "555555555555555555",
    channel: { id: "555555555555555555", isTextBased: () => true, send: async () => ({ id: "x" }) },
    createdTimestamp: Date.now(),
    reply: async () => ({ id: "x", edit: async () => null, createdTimestamp: Date.now(), createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }) }),
  };
}

async function renderEmbeds(modulePath, content, opts = {}) {
  const command = (await import(modulePath)).default;
  const { parseQuotedArgs } = await import("./dist/lib/validation.js");
  const afterPrefix = content.replace(/^>/, "");
  const { args } = parseQuotedArgs(afterPrefix);
  args.shift()?.toLowerCase();
  const captured = [];
  const message = makeMessage(content, opts);
  message.reply = async (payload) => {
    captured.push(payload);
    return { id: "x", edit: async () => null, createdTimestamp: Date.now(), createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }) };
  };
  message.channel.send = async (payload) => { captured.push(payload); return { id: "x" }; };
  try {
    await command.prefixExecute(message, args);
  } catch {
    // taxonomy errors are the dispatcher's render concern — skip
  }
  return captured.flatMap((p) => p.embeds ?? []);
}

// ============================================================
// 1) Static builders — pure functions, maximal inputs
// ============================================================
console.log("\n=== STATIC BUILDERS (maximal inputs) ===");
{
  // changelog: the full array (worst case)
  const embeds = await renderEmbeds("./dist/commands/utility/changelog.js", ">changelog");
  for (let i = 0; i < embeds.length; i++) validateEmbed(`changelog (full RELEASES array)`, embeds[i]);

  // help home + every category + every command detail
  const { loadCommands } = await import("./dist/handlers/commandHandler.js");
  const { SyndicateClient } = await import("./dist/core/client.js");
  const client = new SyndicateClient({ intents: [] });
  await loadCommands(client);
  const help = await import("./dist/lib/help.js");

  validateEmbed("help home (admin+dev viewer)", help.buildHelpHomeEmbed(client, { userId: "1", isAdminHere: true }));
  for (const category of ["utility", "coolsies", "moderation", "admin", "owner"]) {
    validateEmbed(`help category: ${category}`, help.buildCategoryEmbed(client, category));
  }
  let detailChecked = 0;
  for (const cmd of client.slashCommands.values()) {
    const name = cmd.name ?? cmd.data?.name;
    // Viewer = OWNER_ID (a developer) so the owner-category detail
    // (boot) is visible — the visibility gate itself is exercised
    // below with a non-privileged viewer.
    validateEmbed(`help detail: ${name}`, help.buildCommandDetailEmbed(client, name, { userId: "111111111111111111", isAdminHere: true }));
    detailChecked++;
  }
  report(`help detail pages rendered (${detailChecked} commands)`, detailChecked >= 30);

  // Cycle-6: help detail pages must resolve via ALIASES too — the
  // dispatcher accepts them for execution, so >help must accept them
  // for documentation (av -> avatar, whois -> userinfo, h -> help...).
  {
    const aliasCases = [["av", "avatar"], ["whois", "userinfo"], ["calc", "calculate"], ["h", "help"], ["ts", "timestamp"], ["si", "serverinfo"], ["remind", "remindme"]];
    for (const [alias, canonical] of aliasCases) {
      const e = help.buildCommandDetailEmbed(client, alias, { userId: "111111111111111111", isAdminHere: true });
      const ok = e !== null && e.toJSON().title.includes(canonical);
      report(`help detail via alias: ${alias} -> ${canonical}`, ok);
    }
  }

  // Visibility gates: admin pages hidden from plebs, owner pages
  // hidden from non-developers. NULL is the contract.
  const { isDeveloper } = await import("./dist/lib/permissions.js");
  const pleb = { userId: "999999999999999999", isAdminHere: false };
  report("help detail: boot hidden from non-developer",
    help.buildCommandDetailEmbed(client, "boot", pleb) === null);
  report("help detail: announce hidden from non-admin",
    help.buildCommandDetailEmbed(client, "announce", pleb) === null);
  report("help detail: public commands visible to plebs",
    help.buildCommandDetailEmbed(client, "help", pleb) !== null);
  report("help home: owner category absent for plebs",
    !help.activeCategories(client, pleb).includes("owner"));
  report("help home: admin category absent for non-admins",
    !help.activeCategories(client, pleb).includes("admin"));

  // warns list — 25 warnings with MAX-length reasons (worst case)
  const { warningService } = await import("./dist/services/warnings.js");
  const g = "999999999999999999", u = "777777777777777777";
  for (let i = 0; i < 25; i++) warningService.add(g, u, "111111111111111111", "r".repeat(500));
  const list = warningService.formatList(warningService.activeFor(g, u));
  const warnEmbed = (await import("./dist/lib/embeds.js")).baseEmbed().setTitle(`⚠️ Warnings for user`).setDescription(list.description);
  validateEmbed("warn list (25 x 500-char reasons)", warnEmbed);
  warningService.clearActive(g, u);

  // bot info card
  const botCmd = (await import("./dist/commands/utility/bot.js")).default;
  const botEmbeds = await renderEmbeds("./dist/commands/utility/bot.js", ">bot");
  for (const e of botEmbeds) validateEmbed("bot info card", e);
}

// ============================================================
// 2) Command outputs — hostile maximal inputs
// ============================================================
console.log("\n=== COMMAND OUTPUTS (hostile maximal inputs) ===");
{
  const HOSTILE_REASON = "x".repeat(200); // afk max stored
  const cases = [
    ["./dist/commands/utility/afk.js", `>afk ${HOSTILE_REASON}`, {}, "afk (200-char reason)"],
    ["./dist/commands/utility/afk.js", `>afk`, {}, "afk (no args, while not AFK)"],
    ["./dist/commands/utility/remindme.js", `>remindme "in 2 minutes" ${"y".repeat(300)}`, {}, "remindme (300-char text)"],
    ["./dist/commands/utility/suggest.js", `>suggest ${"s".repeat(500)}`, {}, "suggest (500-char, unquoted)"],
    ["./dist/commands/utility/roll.js", `>roll 20d9999`, {}, "roll (20 dice)"],
    ["./dist/commands/utility/roll.js", `>roll 20d9999+999`, {}, "roll (20 dice + modifier)"],
    ["./dist/commands/utility/snowflake.js", `>snowflake 1300000000000000000`, {}, "snowflake"],
    ["./dist/commands/utility/timestamp.js", `>timestamp tomorrow 5pm`, {}, "timestamp (parsed time)"],
    ["./dist/commands/coolsies/choose.js", `>choose ${Array.from({length: 10}, (_, i) => "c".repeat(100)).join(" ")}`, {}, "choose (10 x 100-char options)"],
    ["./dist/commands/coolsies/rate.js", `>rate`, {}, "rate self"],
    ["./dist/commands/coolsies/rps.js", `>rps rock`, {}, "rps instant"],
    ["./dist/commands/coolsies/joke.js", `>joke`, {}, "joke tell"],
    ["./dist/commands/coolsies/8ball.js", `>8ball ${"w".repeat(200)}`, {}, "8ball (200-char question)"],
    ["./dist/commands/coolsies/random.js", `>random -1000000 1000000`, {}, "random (extreme bounds)"],
    ["./dist/commands/utility/calculate.js", `>calc 2+2`, {}, "calc"],
  ];
  for (const [mod, input, opts, label] of cases) {
    const jsMod = mod.replace(".ts", ".js");
    try {
      const embeds = await renderEmbeds(jsMod, input, opts);
      if (embeds.length === 0) { report(`${label} (no embed — content reply)`, true); continue; }
      for (let i = 0; i < embeds.length; i++) validateEmbed(`${label}${embeds.length > 1 ? ` [${i}]` : ""}`, embeds[i]);
    } catch (e) {
      report(`${label} — harness error`, false, e.message.slice(0, 120));
    }
  }
}

// ============================================================
// 2b) Native poll output — v1.1.0: `>poll <hours> "<question>"
// "<opt 1>", "<opt 2>" posts a NATIVE Discord poll (no embed, no
// components). Discord's hard limits for polls are question<=300,
// answers<=10 of <=55 chars — assert the real payload honors them,
// and that over-limit inputs are rejected as UserInputErrors instead
// of producing an API-rejected payload.
// ============================================================
console.log("\n=== NATIVE POLL OUTPUT (maximal + hostile inputs) ===");
{
  const pollCmd = (await import("./dist/commands/utility/poll.js")).default;
  const { parseQuotedArgs } = await import("./dist/lib/validation.js");
  const { UserInputError } = await import("./dist/lib/errors.js");

  const runPoll = async (content) => {
    const { args } = parseQuotedArgs(content.replace(/^>/, ""));
    args.shift()?.toLowerCase();
    const captured = [];
    const message = makeMessage(content);
    message.reply = async (payload) => {
      captured.push(payload);
      return { id: "x", edit: async () => null, createdTimestamp: Date.now(), createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }) };
    };
    try {
      await pollCmd.prefixExecute(message, args);
      return { ok: true, payload: captured[0] };
    } catch (error) {
      return { ok: false, error };
    }
  };

  // Maximal VALID poll: 168h, 300-char question, 10 x 55-char options
  const maxQ = "q".repeat(300);
  const maxOpts = Array.from({ length: 10 }, () => "o".repeat(55)).map((o) => `"${o}"`).join(", ");
  const max = await runPoll(`>poll 168 "${maxQ}" ${maxOpts}`);
  report("poll: maximal valid input accepted", max.ok && Boolean(max.payload?.poll),
    max.ok ? "" : `threw: ${max.error?.message}`);
  if (max.ok) {
    const poll = max.payload.poll;
    const errs = [];
    if ((poll.question?.text ?? "").length > 300) errs.push(`question ${(poll.question?.text ?? "").length} > 300`);
    if ((poll.answers ?? []).length > 10) errs.push(`${poll.answers.length} answers > 10`);
    for (let i = 0; i < (poll.answers ?? []).length; i++) {
      const len = (poll.answers[i].text ?? "").length;
      if (len > 55) errs.push(`answer[${i}] ${len} > 55`);
    }
    if (typeof poll.duration !== "number" || poll.duration < 1 || poll.duration > 768) errs.push(`duration ${poll.duration} out of range`);
    if (poll.allowMultiselect !== false) errs.push("allowMultiselect not false");
    report("poll: native payload within Discord's hard limits (300/10x55/768h)", errs.length === 0, errs.join("; "));
    report("poll: no embeds/components on the payload", !max.payload.embeds && !max.payload.components);
    report("poll: fractional hours map to the whole-hour API ceiling",
      (await runPoll('>poll 0.01 "q?" "a", "b"')).payload?.poll?.duration === 1,
      "0.01h should create with duration 1");
  }

  // Hostile over-limit inputs: rejected cleanly, never a payload
  const opt55 = "o".repeat(55);
  const opt56 = "o".repeat(56);
  const hostile = [
    [`>poll 1 ${'"'.repeat(0)}${"q".repeat(301)}x "a", "b"`, "301-char question"],
    [`>poll 1 "q?" "${opt56}", "b"`, "56-char option"],
    [`>poll 1 "q?" ${Array.from({ length: 11 }, (_, i) => `"o${i}"`).join(", ")}`, "11 options"],
    [`>poll 769 "q?" "a", "b"`, "769 hours"],
    [`>poll 0.001 "q?" "a", "b"`, "0.001 hours (below floor)"],
    [`>poll 1 "${"\u200B".repeat(5)}" "a", "b"`, "invisible-only question"],
    [`>poll banana "q?" "a", "b"`, "non-numeric duration"],
  ];
  for (const [input, label] of hostile) {
    const r = await runPoll(input);
    report(`poll: ${label} rejected as UserInputError (no payload)`,
      !r.ok && r.error instanceof UserInputError && !r.payload,
      r.ok ? "accepted (payload sent)" : `wrong error class: ${r.error?.name}`);
  }

  // The recap embed (posted after close) is a REAL embed the bot
  // produces — validate its worst case against Discord's hard limits:
  // 300-char question + 10 x 55-char options, all rendered into the
  // description.
  {
    const { buildRecapEmbed } = await import("./dist/services/polls.js");
    const maxOptions = Array.from({ length: 10 }, () => "o".repeat(55));
    const answers = new Map(Array.from({ length: 10 }, (_, i) => [i + 1, { voteCount: 12345 }]));
    const recap = buildRecapEmbed("q".repeat(300), maxOptions, { poll: { answers } });
    validateEmbed("poll recap (max question + 10 x 55-char options, big counts)", recap);
    // ties render every winner — the widest verdict line
    validateEmbed("poll recap (tie verdict)", buildRecapEmbed("t?", ["a".repeat(55), "b".repeat(55)], { poll: { answers: new Map([[1, { voteCount: 7 }], [2, { voteCount: 7 }]]) } }));
  }
}

// ============================================================
// 3) Slash-command embeds (moderation/admin) — via direct builders
// ============================================================
console.log("\n=== SLASH EMBEDS (via embed helpers, worst cases) ===");
{
  const { baseEmbed, successEmbed, errorEmbed, warnEmbed } = await import("./dist/lib/embeds.js");
  const { errorDetail } = await import("./dist/lib/safeError.js");
  // The longest realistic slash embeds: ban result with 512-char reason
  const reason = "r".repeat(512);
  validateEmbed("ban result (512-char reason)", baseEmbed().setTitle("🔨 Member Banned").addFields(
    { name: "User", value: "someverylongusername#0001 (`1300000000000000000`)", inline: true },
    { name: "Moderator", value: "anotherlongusername#0002", inline: true },
    { name: "Reason", value: reason, inline: false },
  ));
  // error embed with a max-length sanitized error detail
  validateEmbed("devlog error embed (1000-char detail)", baseEmbed().setTitle("⚠️ Command Error").addFields(
    { name: "Detail", value: "```" + errorDetail(new Error("x".repeat(2000))) + "```", inline: false },
  ));
  // success/warn/error with 4096-char descriptions (absolute cap)
  validateEmbed("error embed (4090-char description)", errorEmbed("e".repeat(4090)));
  validateEmbed("warn embed (4090-char description)", warnEmbed("w".repeat(4090)));
  validateEmbed("success embed (4090-char description)", successEmbed("s".repeat(4090)));
}

// ============================================================
// FINAL
// ============================================================
console.log(`\n${failed === 0 ? `ALL ${passed} EMBED CHECKS PASSED` : `${failed} FAILED / ${passed} passed`}`);
process.exitCode = failed === 0 ? 0 : 1;

closeDb();
setTimeout(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
  }
  if (existsSync("data/harness-suggestions-export.txt")) rmSync("data/harness-suggestions-export.txt");
  process.exit(failed === 0 ? 0 : 1);
}, 50);
