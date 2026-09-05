import { config } from "../core/config.js";

/**
 * Dashboard HTML. Every dynamic value passes through escapeHtml() —
 * stored content (jokes, 8-ball responses, suggestions) is
 * OPERATOR-CONTROLLED but escaped anyway: defense in depth, and the
 * suggestion text comes from Discord users, so it IS hostile.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #13131c; color: #e4e4ef; min-height: 100vh; }
  a { color: #8ea1ff; }
  header { background: #1b1b28; border-bottom: 1px solid #2c2c40; padding: 16px 28px; display: flex; align-items: center; justify-content: space-between; }
  header h1 { font-size: 18px; }
  header .brand { display: flex; align-items: center; gap: 10px; }
  header .ver { color: #77778f; font-size: 12px; }
  main { max-width: 1000px; margin: 0 auto; padding: 28px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; margin-top: 20px; }
  .card { background: #1b1b28; border: 1px solid #2c2c40; border-radius: 12px; padding: 18px; }
  .card h2 { font-size: 15px; margin-bottom: 10px; display: flex; gap: 8px; align-items: center; }
  .card .count { color: #77778f; font-size: 12px; font-weight: normal; }
  .list { max-height: 340px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
  .row { background: #232333; border: 1px solid #2c2c40; border-radius: 8px; padding: 10px 12px; font-size: 13px; display: flex; justify-content: space-between; gap: 10px; align-items: center; }
  .row .id { color: #77778f; min-width: 46px; }
  .row .content { flex: 1; overflow-wrap: anywhere; }
  .row .state { font-size: 11px; color: #77778f; }
  .row .state.off { color: #e4c25a; }
  form.inline { display: flex; gap: 6px; flex-wrap: wrap; }
  input[type=text], input[type=password] { background: #232333; border: 1px solid #2c2c40; color: #e4e4ef; border-radius: 6px; padding: 7px 10px; font-size: 13px; flex: 1; min-width: 120px; }
  button { background: #5865f2; color: #fff; border: 0; border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
  button:hover { background: #4752c4; }
  button.danger { background: #ed4245; }
  button.danger:hover { background: #c93b3e; }
  button.subtle { background: #33334a; }
  .login-wrap { display: flex; justify-content: center; padding-top: 12vh; }
  .login { background: #1b1b28; border: 1px solid #2c2c40; border-radius: 14px; padding: 32px; width: 340px; }
  .login h1 { font-size: 20px; margin-bottom: 6px; }
  .login .sub { color: #77778f; font-size: 13px; margin-bottom: 20px; }
  .login label { font-size: 12px; color: #aaa; display: block; margin: 12px 0 6px; }
  .login button { width: 100%; margin-top: 18px; padding: 10px; }
  .error { color: #ff7d80; font-size: 13px; margin-top: 12px; }
  .banner { background: #2a2436; border: 1px solid #4a3a5c; color: #d8c7ea; padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-top: 14px; }
  .banner.ok { background: #1d2f26; border-color: #2f5a41; color: #b8e6c9; }
  .banner.fail { background: #34201f; border-color: #5a2c2a; color: #ffb3b3; }
  .danger-zone { margin-top: 22px; border-color: #5a2c2c; }
  .danger-zone h2 { color: #ff9c9e; }
  .danger-zone .hint { color: #77778f; font-size: 12px; margin: 6px 0 12px; }
  .row-actions { display: flex; gap: 4px; }
  .row-actions form { display: inline-flex; }
  footer { color: #55556b; font-size: 11px; text-align: center; padding: 26px; }
`;

function layout(title: string, body: string, opts: { sessionToken?: string; csrf?: string } = {}): string {
  const logout =
    opts.sessionToken && opts.csrf
      ? `<form method="post" action="/logout" style="display:inline">
           <input type="hidden" name="csrf" value="${escapeHtml(opts.csrf)}">
           <button class="subtle" type="submit">Sign out</button>
         </form>`
      : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(config.botName)}</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="brand"><h1>⚙️ ${escapeHtml(config.botName)} Dashboard</h1><span class="ver">v${escapeHtml(config.version)}</span></div>
  ${logout}
</header>
${body}
<footer>${escapeHtml(config.botName)} by ${escapeHtml(config.author)} — localhost management console</footer>
</body>
</html>`;
}

export function loginPage(error: string | null, notice: string | null): string {
  const errHtml = error ? `<div class="error">${escapeHtml(error)}</div>` : "";
  const noticeHtml = notice ? `<div class="banner ok">${escapeHtml(notice)}</div>` : "";
  return layout(
    "Sign in",
    `<div class="login-wrap"><div class="login">
      <h1>Sign in</h1>
      <div class="sub">Operators only. Sessions expire after ${Math.round(config.dashboardSessionTtlMs / 60000)} minutes.</div>
      <form method="post" action="/login">
        <label for="password">Dashboard password</label>
        <input type="password" id="password" name="password" autofocus autocomplete="current-password" required>
        ${errHtml}
        ${noticeHtml}
        <button type="submit">Unlock</button>
      </form>
    </div></div>`,
  );
}

export interface CollectionItem {
  id: number;
  content: string;
  enabled: boolean;
}

function collectionCard(
  title: string,
  emoji: string,
  items: CollectionItem[],
  kind: "joke" | "response",
  csrf: string,
  addPlaceholder: string,
  emptyNote: string,
  maxLength: number,
): string {
  const rows = items
    .map(
      (item) => `
      <div class="row">
        <span class="id">#${item.id}</span>
        <span class="content">${escapeHtml(item.content)}</span>
        <span class="state ${item.enabled ? "" : "off"}">${item.enabled ? "in rotation" : "disabled"}</span>
        <span class="row-actions">
          <form method="post" action="/action/${kind}/${item.enabled ? "disable" : "enable"}/${item.id}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="subtle" type="submit" title="${item.enabled ? "Take it out of rotation" : "Put it back in rotation"}">${item.enabled ? "⏸" : "▶"}</button>
          </form>
          <form method="post" action="/action/${kind}/remove/${item.id}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="danger" type="submit" title="Delete permanently">✕</button>
          </form>
        </span>
      </div>`,
    )
    .join("");
  return `
  <div class="card">
    <h2>${emoji} ${escapeHtml(title)} <span class="count">${items.length} total</span></h2>
    <form class="inline" method="post" action="/action/${kind}/add">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="text" name="content" maxlength="${maxLength}" placeholder="${escapeHtml(addPlaceholder)}" required>
      <button type="submit">Add</button>
    </form>
    <div class="list" style="margin-top:12px">
      ${items.length === 0 ? `<div class="row"><span class="content">${escapeHtml(emptyNote)}</span></div>` : rows}
    </div>
  </div>`;
}

export interface DashboardData {
  jokes: CollectionItem[];
  responses: CollectionItem[];
  suggestions: { id: number; content: string; status: string; author: string; at: string }[];
  banner: { kind: "ok" | "fail"; text: string } | null;
  stats: { guilds: number; users: number; uptime: string; reminders: number };
}

export function dashboardPage(data: DashboardData, csrf: string, sessionToken: string): string {
  const suggestionRows = data.suggestions
    .map(
      (s) => `
      <div class="row">
        <span class="id">#${s.id}</span>
        <span class="content">${escapeHtml(s.content)}<br><span class="state">by ${escapeHtml(s.author)} · ${escapeHtml(s.at)}</span></span>
        <span class="state ${s.status === "pending" ? "off" : ""}">${escapeHtml(s.status)}</span>
        <span class="row-actions">
          <form method="post" action="/action/suggestion/approve/${s.id}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="subtle" type="submit" title="Mark approved">✔</button>
          </form>
          <form method="post" action="/action/suggestion/reject/${s.id}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <button class="subtle" type="submit" title="Mark rejected">✖</button>
          </form>
        </span>
      </div>`,
    )
    .join("");

  const banner = data.banner ? `<div class="banner ${data.banner.kind}">${escapeHtml(data.banner.text)}</div>` : "";

  const body = `
  <main>
    ${banner}
    <div class="cards">
      <div class="card">
        <h2>📡 Status</h2>
        <div class="list">
          <div class="row"><span class="content">Servers</span><span class="state">${data.stats.guilds}</span></div>
          <div class="row"><span class="content">Members (combined)</span><span class="state">${data.stats.users}</span></div>
          <div class="row"><span class="content">Uptime</span><span class="state">${escapeHtml(data.stats.uptime)}</span></div>
          <div class="row"><span class="content">Pending reminders</span><span class="state">${data.stats.reminders}</span></div>
        </div>
      </div>
      <div class="card">
        <h2>💡 Suggestions <span class="count">${data.suggestions.length} newest</span></h2>
        <div class="list">${suggestionRows || `<div class="row"><span class="content">No suggestions yet.</span></div>`}</div>
      </div>
      ${collectionCard("Jokes", "😂", data.jokes, "joke", csrf, "Add a new joke…", "No jokes yet — add the first one.", 500)}
      ${collectionCard("8-Ball Responses", "🎱", data.responses, "response", csrf, "Add a new response…", "No responses yet — add the first one.", 300)}
    </div>
    <div class="card danger-zone">
      <h2>🛑 Process control</h2>
      <div class="hint">Reboot exits for the process manager to restart the bot. Shutdown stops it until started manually. Identical to the /boot panel.</div>
      <form class="inline" method="post" action="/action/reboot">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button type="submit">🔄 Reboot</button>
      </form>
      <form class="inline" method="post" action="/action/shutdown">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button class="danger" type="submit">🛑 Shut down</button>
      </form>
    </div>
  </main>`;
  return layout("Dashboard", body, { sessionToken, csrf });
}
