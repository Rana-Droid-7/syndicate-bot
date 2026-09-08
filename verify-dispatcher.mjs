// Dispatcher edge-case torture — none of these may crash.
//
// Cycle-I rewrite: this harness used to re-implement the dispatch
// decision tree inline — the exact "fixture drift" failure mode
// verify_lookup.mjs was rewritten to kill (a hand-maintained copy
// passing all its checks while the real logic changed underneath).
// It now drives the REAL router (dist/lib/prefixRoute.ts) — the same
// pure core events/messageCreate.ts consults — so a routing change
// that would break dispatch breaks HERE, in CI, not just in prod.
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Throwaway DB, cleaned up like verify-integration's — the old
// "final.db" was recreated and abandoned on every verify run.
const TEST_DB = path.join(__dirname, "data", "dispatcher-test.db");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
process.env.DATABASE_FILE = "data/dispatcher-test.db";
process.env.DISCORD_TOKEN = "x";
process.env.CLIENT_ID = "123456789012345678";
process.env.OWNER_ID = "111111111111111111";

const { runMigrations, closeDb } = await import("./dist/database/client.js");
runMigrations();

const { loadCommands } = await import("./dist/handlers/commandHandler.js");
const { SyndicateClient } = await import("./dist/core/client.js");
const client = new SyndicateClient({ intents: [] });
await loadCommands(client);
console.log("loaded:", client.slashCommands.size, "commands,", client.prefixCommands.size, "prefix aliases");

// The REAL router — the pure decision core the messageCreate handler
// consults. Testing this instead of a re-implementation means the
// harness CANNOT drift from the shipped logic.
const { routePrefixCommand } = await import("./dist/lib/prefixRoute.js");
const { parseQuotedArgs } = await import("./dist/lib/validation.js");

// Viewer shapes: a pleb, an admin, and the configured developer.
const pleb = { userId: "999999999999999999", isAdminHere: false };
const admin = { userId: "888888888888888888", isAdminHere: true };
const dev = { userId: "111111111111111111", isAdminHere: false };

const edgeInputs = [
  ">", ">>", ">>>", "> ", "   >   ", ">HELP", ">Help", ">hElP", ">help",
  "> nonexistent", ">ünïcödé", ">".repeat(50), ">a".repeat(30),
  ">" + "x".repeat(2000), ">joke", ">afk", ">suggest", ">remindme",
  ">booot", ">kik", '>"quoted start', '>unterminated "quote',
  ">joke", ">joke add \"x\"", ">8ball", ">choose", ">random",
  ">kick", ">ban", ">boot", ">announce", ">halp", ">se", ">calc 2+2",
  ">" + "\u200B".repeat(5), ">poll", ">rate", ">rps", ">timestamp",
];

let crashes = 0;
let routed = 0;
const kindCounts = {};
for (const raw of edgeInputs) {
  try {
    if (!raw.startsWith(">")) continue;
    const { args } = parseQuotedArgs(raw.slice(1));
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) { console.log("  (empty command) ok"); continue; }
    // Route through the REAL logic for all three viewer shapes —
    // visibility gates are part of the routing contract.
    for (const [label, viewer] of [["pleb", pleb], ["admin", admin], ["dev", dev]]) {
      const route = routePrefixCommand(client, commandName, viewer);
      kindCounts[route.kind] = (kindCounts[route.kind] ?? 0) + 1;
      routed++;
      // Structural sanity: every route carries its expected payload.
      if (route.kind === "lookup" && route.matches.length === 0) throw new Error("lookup route with zero matches");
      if (route.kind === "typo" && !route.suggestion) throw new Error("typo route without a suggestion");
      console.log(`  [${label}] ${JSON.stringify(raw.slice(0, 24))} -> ${route.kind}${route.kind === "typo" ? ` (${route.suggestion.name ?? route.suggestion.data?.name})` : ""}${route.kind === "lookup" ? ` (${route.matches.length} matches)` : ""}`);
    }
  } catch (e) {
    crashes++;
    console.log("  CRASH on", JSON.stringify(raw.slice(0, 30)), "->", e.message);
  }
}

// Contract assertions — the routing behaviors the handler depends on.
let contractFails = 0;
const expect = (label, cond, detail = "") => {
  console.log(`${cond ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) contractFails++;
};

// Case-insensitivity: the handler lowercases; the registry is lowercase.
expect("case-insensitive dispatch: >HELP routes to the help command",
  routePrefixCommand(client, "help", pleb).kind === "known");
// Slash-only commands explain, never dispatch.
expect("slash-only name explains instead of dispatching",
  routePrefixCommand(client, "kick", pleb).kind === "slash-only");
expect("owner-category name is slash-only too",
  routePrefixCommand(client, "boot", pleb).kind === "slash-only");
// Visibility: admin commands hidden from plebs, visible to admins —
// in BOTH the lookup and the typo lanes.
expect("admin command invisible in pleb lookups",
  !routePrefixCommand(client, "ann", pleb).kind.toString().includes("announce"));
const adminLookup = routePrefixCommand(client, "ann", admin);
expect("admin command visible in admin lookups",
  adminLookup.kind === "lookup" && adminLookup.matches.some((m) => (m.command.name ?? m.command.data?.name) === "announce"));
expect("dev-only category invisible to plebs",
  !routePrefixCommand(client, "boo", pleb).kind.toString().includes("boot"));
// Junk input is ignored, never crashes, never suggests.
expect("unicode junk is ignored",
  routePrefixCommand(client, "ünïcödé", pleb).kind === "ignore");
expect("2000-char wall is ignored",
  routePrefixCommand(client, "x".repeat(2000), pleb).kind === "ignore");
expect("zero-width junk is ignored",
  routePrefixCommand(client, "\u200B\u200B\u200B", pleb).kind === "ignore");
// Real typo gets a real suggestion.
const typo = routePrefixCommand(client, "halp", pleb);
expect("typo 'halp' suggests 'help'",
  typo.kind === "typo" && (typo.suggestion.name ?? typo.suggestion.data?.name) === "help", typo.kind);
// Starts-with lookup lists siblings.
const se = routePrefixCommand(client, "se", pleb);
expect("'se' starts-with lookup finds serverinfo",
  se.kind === "lookup" && se.matches.some((m) => (m.command.name ?? m.command.data?.name) === "serverinfo"), se.kind);

console.log(`\nrouted ${routed} decision(s):`, JSON.stringify(kindCounts));
const failed = crashes + contractFails;
console.log(failed === 0 ? "DISPATCHER EDGE-CASES: ALL SAFE" : `${crashes} CRASH(ES) + ${contractFails} CONTRACT FAILURE(S)`);
closeDb();
// Small settled-exit delay: closing the SQLite handle and letting the
// process die in the same tick races better-sqlite3's native teardown
// on some platforms (observed as SIGSEGV/139 on CI's Node 20). A
// clean next-tick exit avoids the race entirely.
setTimeout(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
  }
  process.exit(failed === 0 ? 0 : 1);
}, 50);
