import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";
import { formatDuration } from "../lib/format.js";
import { gracefulExit } from "../lib/shutdown.js";
import { jokeService } from "../services/jokes.js";
import { eightBallService } from "../services/eightball.js";
import { suggestionRepository } from "../repositories/suggestions.js";
import { reminderRepository } from "../repositories/reminders.js";
import { warningRepository } from "../repositories/warnings.js";
import { afkRepository } from "../repositories/afk.js";
import { jokeRepository } from "../repositories/jokes.js";
import { eightBallRepository } from "../repositories/eightball.js";
import {
  clientIp,
  clearFailures,
  createSession,
  dropSession,
  isLockedOut,
  parseFormBody,
  parsePasswordHash,
  recordFailure,
  sessionCsrf,
  verifyPassword,
  sweepSessions,
} from "./auth.js";
import { dashboardPage, editPage, loginPage, type CollectionItem, type DashboardData } from "./pages.js";

/**
 * The localhost management dashboard.
 *
 * Security model (layered, defense in depth):
 *  1. NETWORK: binds 127.0.0.1 by default — remote hosts cannot even
 *     open a connection. Binding elsewhere requires a deliberate
 *     DASHBOARD_HOST override AND a valid password hash.
 *  2. AUTH: PBKDF2-hashed password, timing-safe verification, 5-strike
 *     rate limit with 10-minute lockout.
 *  3. SESSIONS: 256-bit random tokens, SHA-256-hashed at rest,
 *     2-hour TTL, per-session CSRF token required on every POST.
 *  4. ACTIONS: only operator verbs, executed through the SAME service
 *     layer the Discord commands use — no new SQL, no privilege
 *     escalation, all mutations logged to the mirrored ADMIN feed.
 *
 * Refuses to boot without a valid password hash — an unauthenticated
 * dashboard is worse than none.
 */

const MAX_BODY_BYTES = 64 * 1024; // forms are tiny; anything bigger is abuse
const SESSION_COOKIE = "syndicate_session";

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  // Everything is inline-rendered server-side with no external
  // assets — a strict CSP blocks ANY injected script from running
  // even if an escaping bug ever slipped through.
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
}

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.end(body);
}

/** Marker for expected client-abuse rejections (oversized bodies) —
 *  logged as a warn, not an error stack. */
class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(Buffer.concat(chunks));
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (chunks.reduce((n, c) => n + c.length, 0) + chunk.length > MAX_BODY_BYTES) {
        req.destroy();
        finish(new BodyTooLargeError("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null));
    req.on("error", (err) => finish(err));
  });
}

function sessionTokenOf(req: IncomingMessage): string | undefined {
  const cookie = req.headers.cookie ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

function buildDashboardHtml(
  req: IncomingMessage,
  client: Client,
  banner: DashboardData["banner"],
): string | null {
  const token = sessionTokenOf(req);
  const csrf = sessionCsrf(token);
  if (!csrf) return null;

  const jokes: CollectionItem[] = jokeService.list(15, 0).map((j) => ({
    id: j.id, content: j.content, enabled: j.enabled === 1,
  }));
  const responses: CollectionItem[] = eightBallService.list(15, 0).map((r) => ({
    id: r.id, content: r.content, enabled: r.enabled === 1,
  }));
  // Suggestions come from Discord users — hostile text, escaped in pages.ts.
  const suggestions = suggestionRepository.recent(15).map((s) => ({
    id: s.id, content: s.content, status: s.status, author: s.author_id, at: s.created_at,
  }));

  return dashboardPage(
    {
      jokes,
      responses,
      suggestions,
      banner,
      stats: {
        guilds: client.guilds?.cache?.size ?? 0,
        users: client.guilds?.cache?.reduce((acc, g) => acc + (g.memberCount ?? 0), 0) ?? 0,
        uptime: formatDuration(client.uptime ?? 0),
        reminders: reminderRepository.pending().length,
        jokes: jokeService.countAll(),
        responses: eightBallService.countAll(),
        warnings: warningRepository.totalActive(),
        afk: afkRepository.count(),
      },
    },
    csrf,
    token ?? "",
  );
}

function redirect(res: ServerResponse, location: string, token?: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  if (token) {
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.dashboardSessionTtlMs / 1000}`,
    );
  }
  res.end();
}

export function startDashboard(client: Client): void {
  if (!config.dashboardEnabled) {
    log.debug("BOOT", "Dashboard disabled (DASHBOARD_ENABLED not \"true\").");
    return;
  }
  if (!config.dashboardPasswordHash) {
    log.warn(
      "BOOT",
      'DASHBOARD_ENABLED=true but DASHBOARD_PASSWORD_HASH is not set — dashboard NOT starting. Generate one with: node scripts/hash-password.mjs',
    );
    return;
  }
  // A present-but-malformed hash would boot a dashboard that can
  // never accept ANY password — silent, confusing failure. Refuse
  // to start with the exact reason instead.
  if (!parsePasswordHash(config.dashboardPasswordHash)) {
    log.warn(
      "BOOT",
      'DASHBOARD_PASSWORD_HASH is malformed (expected format: pbkdf2$<iterations>$<saltHex>$<hashHex>) — dashboard NOT starting. Regenerate it with: npm run hash-password',
    );
    return;
  }

  const server = createServer(async (req, res) => {
    try {
      setSecurityHeaders(res);
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname;
      const ip = clientIp(req);

      // ---------- GET ----------
      if (req.method === "GET") {
        if (path === "/") {
          const html = buildDashboardHtml(req, client, null);
          // notice is operator-authored (logout redirect) — cap length
          // so a hand-crafted huge URL can't bloat the page.
          const notice = url.searchParams.get("notice")?.slice(0, 200) ?? null;
          send(res, 200, html ?? loginPage(null, notice));
          return;
        }
        if (path === "/favicon.ico") {
          res.statusCode = 204;
          res.end();
          return;
        }
        send(res, 404, loginPage("Not found.", null));
        return;
      }

      // HEAD /: health probe for the dashboard itself (same auth as GET).
      if (req.method === "HEAD") {
        const authed = Boolean(sessionCsrf(sessionTokenOf(req)));
        res.statusCode = authed ? 200 : 401;
        res.end();
        return;
      }

      // ---------- POST ----------
      if (req.method === "POST") {
        const body = await readBody(req);
        const form = parseFormBody(body);

        if (path === "/login") {
          if (isLockedOut(ip)) {
            log.warn("ADMIN", `Dashboard login attempt from locked-out ${ip}.`);
            send(res, 429, loginPage("Too many failed attempts — try again in 10 minutes.", null));
            return;
          }
          const password = form.get("password") ?? "";
          if (!(await verifyPassword(password))) {
            recordFailure(ip);
            log.warn("ADMIN", `Dashboard login FAILURE from ${ip}.`);
            send(res, 401, loginPage("Wrong password.", null));
            return;
          }
          clearFailures(ip);
          const { token } = createSession();
          log.info("ADMIN", `Dashboard login OK from ${ip} — session created.`);
          redirect(res, "/", token);
          return;
        }

        // Everything below requires a valid session + CSRF token.
        const csrf = sessionCsrf(sessionTokenOf(req));
        if (!csrf) {
          send(res, 401, loginPage("Session expired — sign in again.", null));
          return;
        }
        if (form.get("csrf") !== csrf) {
          log.warn("ADMIN", `Dashboard POST with bad/missing CSRF from ${ip} (${path}).`);
          send(res, 403, loginPage("Invalid request token — sign in again.", null));
          return;
        }

        if (path === "/logout") {
          dropSession(sessionTokenOf(req)!);
          log.info("ADMIN", "Dashboard session signed out.");
          redirect(res, "/?notice=Signed%20out.");
          return;
        }

        if (path === "/action/reboot" || path === "/action/shutdown") {
          // The request itself (valid session + CSRF) is the confirmation.
          log.warn("ADMIN", `Dashboard process control: ${path === "/action/reboot" ? "REBOOT" : "SHUTDOWN"} requested.`);
          send(res, 200, `<html><body style="background:#13131c;color:#e4e4ef;font-family:system-ui;padding:40px">
            <h2>✅ ${path === "/action/reboot" ? "Rebooting" : "Shutting down"}…</h2>
            <p style="color:#77778f">This tab can be closed.</p></body></html>`);
          // Let the response flush before tearing the process down.
          setTimeout(() => {
            void gracefulExit(client, {
              reboot: path === "/action/reboot",
              reason: "dashboard",
              requestedBy: ip,
            });
          }, 250);
          return;
        }

        // /action/<kind>/<verb>[/<id>]
        const actionMatch = path.match(/^\/action\/([a-z]+)\/([a-z]+)(?:\/(\d+))?$/);
        if (actionMatch) {
          const [, kind, verb, idStr] = actionMatch;
          const id = idStr ? Number(idStr) : null;

          // Edit view: POST (with CSRF) rendering the edit form —
          // keeps every state change behind the CSRF gate. O(1) row
          // fetch by id (list+find would miss rows past the limit).
          if ((kind === "joke" || kind === "response") && verb === "edit" && id !== null) {
            const repo = kind === "joke" ? jokeRepository : eightBallRepository;
            const row = repo.get(id);
            if (!row) {
              const html = buildDashboardHtml(req, client, { kind: "fail", text: `No #${id} to edit.` });
              send(res, 200, html ?? loginPage(null, null));
              return;
            }
            send(res, 200, editPage(kind, row.id, row.content, csrf, sessionTokenOf(req) ?? ""));
            return;
          }

          // Save the edited content.
          if ((kind === "joke" || kind === "response") && verb === "save" && id !== null) {
            const svc = kind === "joke" ? jokeService : eightBallService;
            const content = (form.get("content") ?? "").trim();
            const banner = content
              ? svc.edit(id, content)
                ? ({ kind: "ok", text: `Saved #${id}.` } as const)
                : ({ kind: "fail", text: `No #${id} to save.` } as const)
              : ({ kind: "fail", text: "Empty content — nothing saved." } as const);
            const html = buildDashboardHtml(req, client, banner);
            send(res, 200, html ?? loginPage(null, null));
            return;
          }

          let banner: { kind: "ok" | "fail"; text: string };

          try {
            banner = runAction(kind, verb, id, form);
          } catch (error) {
            log.error("ADMIN", `Dashboard action failed: ${kind}/${verb}${id ? "/" + id : ""}`, error);
            banner = { kind: "fail", text: "That action failed — check the bot console." };
          }

          const html = buildDashboardHtml(req, client, banner);
          send(res, 200, html ?? loginPage(null, null));
          return;
        }

        send(res, 404, loginPage("Not found.", null));
        return;
      }

      res.statusCode = 405;
      res.end();
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        // Expected abuse, handled by design — warn, no stack noise.
        log.warn("ADMIN", `Dashboard rejected oversized body from ${clientIp(req)}.`);
      } else {
        log.error("ADMIN", "Dashboard request handler error", error);
      }
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain");
      }
      res.end("Internal error");
    }
  });

  // Session sweeper — expired tokens never linger.
  const sweepTimer = setInterval(() => sweepSessions(), 10 * 60 * 1000);
  sweepTimer.unref();

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    log.info(
      "BOOT",
      `Dashboard listening on http://${config.dashboardHost}:${config.dashboardPort} (auth: PBKDF2, sessions+CSRF, rate-limited).`,
    );
  });

  server.on("error", (error) => {
    log.error("BOOT", `Dashboard failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Executes an operator action through the service layer. Returns the UI banner. */
function runAction(
  kind: string,
  verb: string,
  id: number | null,
  form: Map<string, string>,
): { kind: "ok" | "fail"; text: string } {
  const fail = (text: string) => ({ kind: "fail" as const, text });
  const ok = (text: string) => ({ kind: "ok" as const, text });

  if (kind === "joke" || kind === "response") {
    const svc = kind === "joke" ? jokeService : eightBallService;
    const noun = kind === "joke" ? "Joke" : "Response";

    if (verb === "add") {
      const content = (form.get("content") ?? "").trim();
      if (!content) return fail("Empty content — nothing added.");
      const newId = svc.add(content, "dashboard");
      return ok(`${noun} #${newId} added.`);
    }
    if (id === null) return fail("Missing ID.");
    if (verb === "remove") {
      return svc.remove(id) ? ok(`${noun} #${id} removed.`) : fail(`No ${noun.toLowerCase()} #${id}.`);
    }
    if (verb === "enable") {
      return svc.setEnabled(id, true) ? ok(`${noun} #${id} enabled.`) : fail(`No ${noun.toLowerCase()} #${id}.`);
    }
    if (verb === "disable") {
      return svc.setEnabled(id, false) ? ok(`${noun} #${id} disabled.`) : fail(`No ${noun.toLowerCase()} #${id}.`);
    }
    return fail(`Unknown verb "${verb}".`);
  }

  if (kind === "suggestion") {
    if (id === null) return fail("Missing ID.");
    if (verb !== "approve" && verb !== "reject" && verb !== "implement") return fail(`Unknown verb "${verb}".`);
    const status = verb === "approve" ? "approved" : verb === "reject" ? "rejected" : "implemented";
    if (!suggestionRepository.setStatus(id, status)) return fail(`No suggestion #${id}.`);
    log.info("ADMIN", `Dashboard: suggestion #${id} marked ${status}.`);
    return ok(`Suggestion #${id} marked ${status}.`);
  }

  return fail(`Unknown action kind "${kind}".`);
}
