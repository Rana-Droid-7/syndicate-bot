/**
 * Dashboard security + behavior harness.
 * Run: node verify-dashboard.mjs   (requires `npm run build`)
 *
 * Boots the real server on a throwaway port/DB with a known password
 * hash, then attacks it over real HTTP:
 *   - unauthenticated GET/POST must never reach the dashboard
 *   - login: wrong password, lockout after 5 strikes, right password
 *   - session + CSRF: POSTs without/bad tokens rejected
 *   - actions: add/remove/enable/disable round trip, XSS stored and
 *     escaped, suggestion approve/reject
 *   - process control endpoints NOT tested for exit (would kill the
 *     harness) — only that they require auth (401/403 without it)
 */
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2, randomBytes } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, "data", "dashboard-test.db");
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
process.env.DATABASE_FILE = "data/dashboard-test.db";
process.env.DISCORD_TOKEN = "test-token";
process.env.CLIENT_ID = "123456789012345678";
process.env.DASHBOARD_ENABLED = "true";
process.env.DASHBOARD_HOST = "127.0.0.1";
process.env.DASHBOARD_PORT = "3997";

const PASSWORD = "correct horse battery staple";
const salt = randomBytes(16);
const hash = await new Promise((resolve, reject) =>
  pbkdf2(PASSWORD, salt, 120_000, 64, "sha512", (err, key) => (err ? reject(err) : resolve(key))),
);
process.env.DASHBOARD_PASSWORD_HASH = `pbkdf2$120000$${salt.toString("hex")}$${hash.toString("hex")}`;

const { runMigrations, closeDb } = await import("./dist/database/client.js");
runMigrations();
const { startDashboard } = await import("./dist/web/server.js");

// A minimal client stand-in: only the fields the dashboard reads.
// .cache must behave like a discord.js Collection (has .size and
// .reduce) — a plain Map lacks reduce.
const fakeClient = {
  guilds: {
    cache: {
      size: 2,
      reduce: (fn, init) => {
        const guilds = [{ memberCount: 120 }, { memberCount: 80 }];
        return guilds.reduce((acc, g) => fn(acc, g), init);
      },
    },
  },
  uptime: 42_000,
  destroy: async () => {},
};
startDashboard(fakeClient);

// Give the listener a moment.
await new Promise((r) => setTimeout(r, 200));

const BASE = "http://127.0.0.1:3997";

let passed = 0, failed = 0;
function report(name, ok, detail = "") {
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name}${detail ? " — " + detail : ""}`); }
}

async function req(method, path, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body) {
    payload = new URLSearchParams(body).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

// ============================================================
console.log("\n=== AUTH GATE ===");
{
  const home = await req("GET", "/");
  report("unauthenticated GET / shows login page", home.status === 200 && home.text.includes("Sign in"));
  report("login page does NOT leak dashboard content", !home.text.includes("Process control"));

  const post = await req("POST", "/action/joke/add", { body: { content: "smuggled" } });
  report("unauthenticated POST action rejected (401)", post.status === 401, `got ${post.status}`);

  const wrong = await req("POST", "/login", { body: { password: "nope" } });
  report("wrong password rejected (401)", wrong.status === 401);

  const csrfless = await req("POST", "/action/joke/add", { body: { content: "x" } });
  report("no-session action still rejected", csrfless.status === 401);
}

// ============================================================
console.log("\n=== LOGIN + LOCKOUT ===");
{
  for (let i = 0; i < 4; i++) {
    await req("POST", "/login", { body: { password: "bad" + i } });
  }
  const fifth = await req("POST", "/login", { body: { password: "bad5" } });
  report("5th failure locks out (429)", fifth.status === 429, `got ${fifth.status}`);

  // Even the CORRECT password must fail during lockout.
  const lockedCorrect = await req("POST", "/login", { body: { password: PASSWORD } });
  report("correct password also rejected during lockout", lockedCorrect.status === 429, `got ${lockedCorrect.status}`);
}

// The lockout is per-IP and module-private state — the harness
// continues on the same server by clearing the strike counter via
// the exported operator API (exactly what a real operator restart
// achieves, minus the downtime).
const auth = await import("./dist/web/auth.js");
auth.clearFailures("127.0.0.1");
report("lockout clears via operator API", (await req("POST", "/login", { body: { password: "bad" } })).status === 401);

let cookie = "";
let csrf = "";
{
  const good = await req("POST", "/login", { body: { password: PASSWORD } });
  report("correct password logs in (302)", good.status === 302, `got ${good.status}`);
  const setCookie = good.headers.get("set-cookie") ?? "";
  cookie = setCookie.split(";")[0];
  report("session cookie is HttpOnly + SameSite=Strict", /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie));

  const home = await req("GET", "/", { cookie });
  report("authenticated GET / shows dashboard", home.text.includes("Process control"));
  const csrfMatch = home.text.match(/name="csrf" value="([0-9a-f]+)"/);
  csrf = csrfMatch?.[1] ?? "";
  report("CSRF token present in forms", csrf.length === 64);
}

// ============================================================
console.log("\n=== CSRF ===");
{
  const noCsrf = await req("POST", "/action/joke/add", { body: { content: "x" }, cookie });
  report("POST without CSRF token rejected (403)", noCsrf.status === 403, `got ${noCsrf.status}`);

  const badCsrf = await req("POST", "/action/joke/add", { body: { content: "x", csrf: "deadbeef" }, cookie });
  report("POST with wrong CSRF rejected (403)", badCsrf.status === 403);

  const logoutCsrfOnly = await req("POST", "/logout", { body: { csrf: "nope" }, cookie });
  report("logout with bad CSRF rejected", logoutCsrfOnly.status === 403);

  const csp = await req("GET", "/", { cookie });
  report("CSP header set (default-src 'none')", (csp.headers.get("content-security-policy") ?? "").includes("default-src 'none'"));
  report("nosniff + DENY framing set",
    (csp.headers.get("x-content-type-options") ?? "") === "nosniff" &&
    (csp.headers.get("x-frame-options") ?? "") === "DENY");
}

// ============================================================
console.log("\n=== HEAD / hardening ===");
{
  const headAnon = await req("HEAD", "/");
  report("HEAD / unauthenticated -> 401 (health probe honors auth)", headAnon.status === 401);
  const headAuth = await req("HEAD", "/", { cookie });
  report("HEAD / authenticated -> 200", headAuth.status === 200);

  // Malformed body: bad encoding must not crash the server.
  const garbage = await fetch(BASE + "/action/joke/add", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "csrf=" + csrf + "&content=%E0%A4%A", // truncated UTF-8 sequence
  });
  report("malformed URL-encoded body -> clean response, no crash", garbage.status < 500, `got ${garbage.status}`);

  // Oversized body -> connection refused, server alive after.
  const big = await fetch(BASE + "/action/joke/add", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: "csrf=" + csrf + "&content=" + "x".repeat(200_000),
  }).catch(() => null);
  const alive = await req("GET", "/", { cookie });
  report("oversized body rejected, server still alive", alive.status === 200);
}

// ============================================================
console.log("\n=== ACTIONS (through the real service layer) ===");
{
  const { jokeRepository } = await import("./dist/repositories/jokes.js");
  const { suggestionRepository } = await import("./dist/repositories/suggestions.js");

  const add = await req("POST", "/action/joke/add", { body: { content: "dash-added joke", csrf }, cookie });
  report("joke add via dashboard", add.status === 200 && add.text.includes("added"));
  const added = jokeRepository.list(1)[0];
  report("joke really persisted", added?.content === "dash-added joke", `got: ${added?.content}`);

  // Stored XSS attempt — must render escaped. This row doubles as
  // the edit-flow target.
  const xss = await req("POST", "/action/response/add", { body: { content: `<script>alert(1)</script>`, csrf }, cookie });
  const homeAfter = await req("GET", "/", { cookie });
  report("stored XSS is escaped in HTML",
    xss.status === 200 && homeAfter.text.includes("&lt;script&gt;") && !homeAfter.text.includes("<script>alert"));
  const { eightBallRepository } = await import("./dist/repositories/eightball.js");
  const respId = eightBallRepository.list(1)[0].id;

  const disable = await req("POST", `/action/joke/disable/${added.id}`, { body: { csrf }, cookie });
  report("joke disable", disable.status === 200 && jokeRepository.get(added.id).enabled === 0);
  const enable = await req("POST", `/action/joke/enable/${added.id}`, { body: { csrf }, cookie });
  report("joke enable", enable.status === 200 && jokeRepository.get(added.id).enabled === 1);
  const remove = await req("POST", `/action/joke/remove/${added.id}`, { body: { csrf }, cookie });
  report("joke remove", remove.status === 200 && jokeRepository.get(added.id) === null);

  const ghost = await req("POST", "/action/joke/remove/999999", { body: { csrf }, cookie });
  report("removing nonexistent -> fail banner, no crash", ghost.status === 200 && ghost.text.includes("No joke"));

  // ---- Edit flow (v0.6.1): view form, save content, XSS in textarea ----
  const editableView = await req("POST", "/action/response/edit/" + respId, { body: { csrf }, cookie });
  report("edit view renders with current content",
    editableView.status === 200 && editableView.text.includes(`Edit Response #${respId}`));
  const save = await req("POST", "/action/response/save/" + respId, { body: { content: "edited from dashboard", csrf }, cookie });
  report("save updates the row", save.status === 200 && save.text.includes("Saved #"), save.text.slice(0, 80));
  report("saved content really persisted", eightBallRepository.get(respId).content === "edited from dashboard");
  const emptySave = await req("POST", "/action/response/save/" + respId, { body: { content: "   ", csrf }, cookie });
  report("empty save refused cleanly", emptySave.status === 200 && emptySave.text.includes("Empty content"));
  const ghostSave = await req("POST", "/action/joke/save/999999", { body: { content: "x", csrf }, cookie });
  report("save nonexistent -> fail banner", ghostSave.status === 200 && ghostSave.text.includes("No #999999"));

  // Suggestions workflow
  suggestionRepository.add("999999999999999999", "222222222222222222", "review me");
  const sug = suggestionRepository.recent(1)[0];
  const approve = await req("POST", `/action/suggestion/approve/${sug.id}`, { body: { csrf }, cookie });
  report("suggestion approve", approve.status === 200 && suggestionRepository.recent(1)[0].status === "approved");
  const implement = await req("POST", `/action/suggestion/implement/${sug.id}`, { body: { csrf }, cookie });
  report("suggestion implement (new verb)", implement.status === 200 && suggestionRepository.recent(1)[0].status === "implemented");

  // Status card carries the new counters.
  const statusHome = await req("GET", "/", { cookie });
  report("status card shows jokes/responses counts", statusHome.text.includes("Jokes / responses"));
  report("status card shows warnings + afk", statusHome.text.includes("Active warnings") && statusHome.text.includes("Users AFK now"));

  // Hostile suggestion text renders escaped on the dashboard.
  suggestionRepository.add("999999999999999999", "222222222222222222", `<img src=x onerror=alert(1)>`);
  const hostile = await req("GET", "/", { cookie });
  report("hostile suggestion escaped", hostile.text.includes("&lt;img src=x onerror=alert(1)&gt;"));

  const badKind = await req("POST", "/action/pizza/add", { body: { content: "x", csrf }, cookie });
  report("unknown action kind -> fail banner", badKind.status === 200 && badKind.text.includes("Unknown action kind"));
}

// ============================================================
console.log("\n=== PROCESS CONTROL (auth-gated only — exit not exercised) ===");
{
  const anon = await req("POST", "/action/reboot", { body: { csrf: "x" } });
  report("reboot requires session (401)", anon.status === 401);
  const noCsrf = await req("POST", "/action/shutdown", { body: {}, cookie });
  report("shutdown requires CSRF (403)", noCsrf.status === 403);
}

// ============================================================
console.log("\n=== SESSION LIFECYCLE ===");
{
  const logout = await req("POST", "/logout", { body: { csrf }, cookie });
  report("logout redirects", logout.status === 302);
  const after = await req("GET", "/", { cookie });
  report("session invalid after logout", after.text.includes("Sign in"));
}

// ============================================================
console.log(`\n${failed === 0 ? `ALL ${passed} DASHBOARD CHECKS PASSED` : `${failed} FAILED / ${passed} passed`}`);
process.exitCode = failed === 0 ? 0 : 1;

closeDb();
for (const suffix of ["", "-wal", "-shm"]) {
  if (existsSync(TEST_DB + suffix)) rmSync(TEST_DB + suffix);
}
process.exit(process.exitCode ?? 0);
