// Dispatcher edge-case torture test — none of these may crash.
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

const { runMigrations, closeDb } = await import("./dist/database/client.js");
runMigrations();

const { loadCommands } = await import("./dist/handlers/commandHandler.js");
const { SyndicateClient } = await import("./dist/core/client.js");
const client = new SyndicateClient({ intents: [] });
await loadCommands(client);
console.log("loaded:", client.slashCommands.size, "commands,", client.prefixCommands.size, "prefix aliases");

const { parseQuotedArgs } = await import("./dist/lib/validation.js");
const { findStartsWithMatches, findClosestMatch } = await import("./dist/lib/suggest.js");

const edgeInputs = [
  ">", ">>", ">>>", "> ", "   >   ", ">HELP", ">Help", ">hElP", ">help",
  "> nonexistent", ">ünïcödé", ">".repeat(50), ">a".repeat(30),
  ">" + "x".repeat(2000), ">joke", ">afk", ">suggest", ">remindme",
  ">booot", ">kik", '>"quoted start', '>unterminated "quote',
  ">joke", ">joke add \"x\"", ">8ball", ">choose", ">random",
];

let crashes = 0;
for (const raw of edgeInputs) {
  try {
    if (!raw.startsWith(">")) continue;
    const { args } = parseQuotedArgs(raw.slice(1));
    const commandName = args.shift()?.toLowerCase();
    if (!commandName) { console.log("  (empty command) ok"); continue; }
    const command = client.prefixCommands.get(commandName);
    if (command) { console.log("  dispatch:", JSON.stringify(raw.slice(0, 30)), "->", command.name ?? command.data?.name); continue; }
    if (client.slashOnlyCommands.has(commandName)) { console.log("  slash-only explain:", commandName); continue; }
    if (commandName.length <= 20 && /^[a-z0-9]+$/i.test(commandName)) {
      const sw = findStartsWithMatches(client.suggestionCandidates, commandName);
      if (sw.length) { console.log("  lookup:", commandName, "->", sw.length, "matches"); continue; }
      if (commandName.length >= 3) {
        const close = findClosestMatch(client.suggestionCandidates, commandName);
        console.log(close ? "  typo: " + commandName + " -> " + (close.name ?? close.data?.name) : "  ignored: " + commandName);
        continue;
      }
    }
    console.log("  ignored:", JSON.stringify(raw.slice(0, 30)));
  } catch (e) {
    crashes++;
    console.log("  CRASH on", JSON.stringify(raw.slice(0, 30)), "->", e.message);
  }
}
console.log(crashes === 0 ? "DISPATCHER EDGE-CASES: ALL SAFE" : crashes + " CRASHES");
closeDb();
// Small settled-exit delay: closing the SQLite handle and letting the
// process die in the same tick races better-sqlite3's native teardown
// on some platforms (observed as SIGSEGV/139 on CI's Node 20). A
// clean next-tick exit avoids the race entirely.
setTimeout(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
  }
  process.exit(crashes === 0 ? 0 : 1);
}, 50);
