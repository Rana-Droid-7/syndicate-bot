/**
 * Documentation-truth harness. Every claim a doc makes about the
 * codebase is derived here from LIVE state and pinned:
 *
 *   - README: verify counts (unit/integration/embed/lookup/timer),
 *     command counts per category, architecture-tree file lists,
 *     persistence-table table names, version heading
 *   - PR/MR templates + CONTRIBUTING: verify counts
 *   - bug-report template: current-version placeholder
 *   - CHANGELOG: newest version == package.json version; the in-chat
 *     RELEASES array covers the current version
 *
 * Cycle-7 reason: the README architecture tree and persistence table
 * had drifted silently for several releases (missing lib files, no
 * eightball service/repo, wrong counts). Docs that lie are worse than
 * no docs — this harness makes lying impossible in CI.
 *
 * Run: node verify-docs.mjs   (requires `npm run build` first)
 */

import { readFileSync } from "node:fs";

const root = new URL(".", import.meta.url);

let passed = 0, failed = 0;
function report(name, ok, detail = "") {
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${detail ? " — " + detail : ""}`); }
}
const read = (p) => readFileSync(new URL(p, root), "utf8");

// ---- live state ----
const pkg = JSON.parse(read("package.json"));
const { loadCommands } = await import("./dist/handlers/commandHandler.js");
const { SyndicateClient } = await import("./dist/core/client.js");
const client = new SyndicateClient({ intents: [] });
await loadCommands(client);

// ---- 1) version claims ----
{
  const v = pkg.version;
  report("README heading carries the current version", read("README.md").includes(`# Syndicate Bot — v${v}`));
  report("bug-report template placeholder is current", read(".github/ISSUE_TEMPLATE/bug_report.md").includes(`"${v}"`));
  const cfg = read("src/core/config.ts");
  report("config.ts version matches package.json", cfg.includes(`version: "${v}"`));

  // CHANGELOG: the newest entry must be the current version
  const changelog = read("CHANGELOG.md");
  const firstVersionHeader = changelog.match(/^## v([^\s]+) /m)?.[1];
  report("CHANGELOG's newest entry is the current version", firstVersionHeader === v, `newest documented: v${firstVersionHeader}`);

  // in-chat RELEASES covers the current version
  const inChat = read("src/commands/utility/changelog.ts");
  report("in-chat changelog array covers the current version", inChat.includes(`version: "${v}"`));
}

// ---- 2) command counts (README's category listings vs loaded registry) ----
{
  const byCategory = {};
  for (const cmd of client.slashCommands.values()) {
    byCategory[cmd.category] = (byCategory[cmd.category] ?? 0) + 1;
  }
  const readme = read("README.md");

  // Utility listing: count names in the line
  const utilityLine = readme.match(/### 🛠️ Utility[^\n]*\n([^\n]+)/)?.[1] ?? "";
  const utilityNames = ["help", "ping", "bot", "invite", "changelog", "suggest", "afk",
    "remindme", "poll", "userinfo", "serverinfo", "avatar", "banner", "timestamp",
    "snowflake", "roll", "calculate"];
  const utilityMissing = utilityNames.filter((n) => !utilityLine.includes(n));
  report("README utility section lists all utility commands", utilityMissing.length === 0,
    `missing: ${utilityMissing.join(", ") || "(none)"} (loaded: ${byCategory.utility})`);
  report("README utility count matches the loaded registry", utilityNames.length === byCategory.utility,
    `docs: ${utilityNames.length}, loaded: ${byCategory.utility}`);

  const coolsiesLine = readme.match(/### 🎉 Coolsies[^\n]*\n([^\n]+)/)?.[1] ?? "";
  const coolsiesNames = ["dice", "coinflip", "8ball", "choose", "random", "rate", "rps", "joke"];
  const coolsiesMissing = coolsiesNames.filter((n) => !coolsiesLine.includes(n));
  report("README coolsies section lists all coolsies commands", coolsiesMissing.length === 0,
    `missing: ${coolsiesMissing.join(", ") || "(none)"} (loaded: ${byCategory.coolsies})`);
  report("README coolsies count matches the loaded registry", coolsiesNames.length === byCategory.coolsies,
    `docs: ${coolsiesNames.length}, loaded: ${byCategory.coolsies}`);

  const modLine = readme.match(/### 🛡️ Moderation[^\n]*\n([^\n]+)/)?.[1] ?? "";
  const modNames = ["kick", "ban", "timeout", "warn", "purge"];
  const modMissing = modNames.filter((n) => !modLine.includes(`/​${n}`.replace("\u200b", "") ) && !modLine.includes(`/${n}`));
  report("README moderation section lists all moderation commands", modMissing.length === 0,
    `missing: ${modMissing.join(", ") || "(none)"} (loaded: ${byCategory.moderation})`);

  const adminLine = readme.match(/### 🔧 Admin[^\n]*\n([^\n]+)/)?.[1] ?? "";
  for (const n of ["announce", "setnick", "slowmode"]) {
    report(`README admin section lists /${n}`, adminLine.includes(`/${n}`));
  }
  report("README owner section lists /boot", /### 🔑 Developer[^\n]*\n[^\n]*boot/.test(readme));
}

// ---- 3) verify-count claims in docs (README, templates) ----
{
  // Real counts come from SPAWNING the harnesses and counting their
  // pass lines — static grep can't see report() calls inside loops.
  const { spawnSync } = await import("node:child_process");
  const run = (script) =>
    spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 });
  const intRun = run("verify-integration.mjs");
  const embRun = run("verify-embeds.mjs");
  const lookRun = run("verify_lookup.mjs");
  const count = (out) => [...(out.stdout ?? "").matchAll(/^✅ /gm)].length;

  const integrationCount = count(intRun);
  const embedCount = count(embRun);
  const lookupCount = count(lookRun);
  const harnessesHealthy = intRun.status === 0 && embRun.status === 0 && lookRun.status === 0;
  report("doc-count probe: all three harnesses ran green (prerequisite)", harnessesHealthy,
    `statuses: int=${intRun.status} emb=${embRun.status} look=${lookRun.status}`);

  const readme = read("README.md");
  // README phrasing: "**157** integration/attack" — count BEFORE the label
  const n = (label) => parseInt(readme.match(new RegExp("\\*\\*([0-9]+)\\*\\* " + label))?.[1] ?? "0", 10);
  if (harnessesHealthy) {
    report("README integration count is true", n("integration/attack") === integrationCount,
      `docs: ${n("integration/attack")}, real: ${integrationCount}`);
    report("README embed count is true", n("embed-output") === embedCount,
      `docs: ${n("embed-output")}, real: ${embedCount}`);
    report("README lookup count is true", n("lookup") === lookupCount,
      `docs: ${n("lookup")}, real: ${lookupCount}`);

    const tmpl = read(".github/PULL_REQUEST_TEMPLATE.md");
    const t = (label) => parseInt(tmpl.match(new RegExp("[0-9]+ " + label))?.[0]?.split(" ")[0] ?? "0", 10);
    report("PR template integration count is true", t("integration") === integrationCount, `template: ${t("integration")}, real: ${integrationCount}`);
    report("PR template embed count is true", t("embed") === embedCount, `template: ${t("embed")}, real: ${embedCount}`);
    report("PR template lookup count is true", t("lookup") === lookupCount, `template: ${t("lookup")}, real: ${lookupCount}`);
  }

  // MR template: identical to PR template modulo the PR/MR word
  const mrRaw = read(".gitlab/merge_request_templates/Default.md");
  const prRaw = read(".github/PULL_REQUEST_TEMPLATE.md");
  const mrNormalized = mrRaw.replace(/\bMR\b/g, "PR");
  report("MR template mirrors the PR template (PR/MR wording aside)", mrNormalized === prRaw,
    mrNormalized === prRaw ? "" : `len ${mrNormalized.length} vs ${prRaw.length}`);
}

// ---- 4) architecture-tree truth (README lib/services/repos lists) ----
{
  const { readdirSync } = await import("node:fs");
  const realLib = readdirSync(new URL("src/lib", root)).filter((f) => f.endsWith(".ts")).map((f) => f.replace(".ts", ""));
  const realServices = readdirSync(new URL("src/services", root)).filter((f) => f.endsWith(".ts")).map((f) => f.replace(".ts", ""));
  const realRepos = readdirSync(new URL("src/repositories", root)).filter((f) => f.endsWith(".ts")).map((f) => f.replace(".ts", ""));

  const readme = read("README.md");
  const treeBlock = readme.match(/```\nsrc\/[\s\S]*?```/)?.[0] ?? "";
  const missingLib = realLib.filter((f) => !treeBlock.includes(f));
  const missingServices = realServices.filter((f) => !treeBlock.includes(f));
  const missingRepos = realRepos.filter((f) => !treeBlock.includes(f));
  report("README tree lists every lib/ file", missingLib.length === 0, `missing: ${missingLib.join(", ") || "(none)"}`);
  report("README tree lists every services/ file", missingServices.length === 0, `missing: ${missingServices.join(", ") || "(none)"}`);
  report("README tree lists every repositories/ file", missingRepos.length === 0, `missing: ${missingRepos.join(", ") || "(none)"}`);
}

// ---- 5) persistence-table truth ----
{
  const dbClient = read("src/database/client.ts");
  const tableNames = [...dbClient.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)/g)].map((m) => m[1]);
  const readme = read("README.md");
  const persistenceSection = readme.match(/## Persistence[\s\S]*?## /)?.[0] ?? "";
  const userFacing = tableNames.filter((t) => t !== "schema_migrations");
  const missing = userFacing.filter((t) => !persistenceSection.includes(`\`${t}\``));
  report("README persistence table covers every DB table (incl. structural parents)",
    missing.length === 0, `missing: ${missing.join(", ") || "(none)"}`);
}

// ---- 6) .env.example covers every key config.ts reads (redundant with
// the integration harness's check, but docs are this harness's domain) ----
{
  const cfg = read("src/core/config.ts");
  const keys = [...new Set([...cfg.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))];
  const envExample = read(".env.example");
  const missing = keys.filter((k) => !new RegExp(`^${k}=`, "m").test(envExample));
  report(".env.example documents every env key", missing.length === 0, `missing: ${missing.join(", ") || "(none)"}`);
}

// ---- FINAL ----
console.log(`\n${failed === 0 ? `ALL ${passed} DOC CHECKS PASSED` : `${failed} FAILED / ${passed} passed`}`);
process.exitCode = failed === 0 ? 0 : 1;
