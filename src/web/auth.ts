import { createHash, pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "../core/config.js";
import { log } from "../core/logger.js";

/**
 * Dashboard authentication.
 *
 * Threat model: the dashboard binds 127.0.0.1 only, so this defends
 * against OTHER LOCAL USERS and malicious pages in the operator's own
 * browser (CSRF/XS attacks) — not remote attackers, who can't reach
 * the port at all.
 *
 * - The password lives ONLY as a PBKDF2 hash in .env
 *   (pbkdf2$<iterations>$<saltHex>$<hashHex>). Plaintext never
 *   touches disk or the process.
 * - Verification is timing-safe (constant-time comparison).
 * - Login is rate-limited per IP; failures lock the endpoint out.
 * - Sessions are unguessable random tokens, hashed at rest in the
 *   session map, with an absolute TTL and a CSRF token bound to the
 *   session that every state-changing POST must present.
 */

const PBKDF2_ITERATIONS = 120_000;
const KEY_LENGTH = 64;

/** Parses the "pbkdf2$iterations$salt$hash" .env format. */
export function parsePasswordHash(raw: string): { iterations: number; salt: Buffer; hash: Buffer } | null {
  const parts = raw.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000) return null;
  try {
    const salt = Buffer.from(parts[2], "hex");
    const hash = Buffer.from(parts[3], "hex");
    if (salt.length < 8 || hash.length !== KEY_LENGTH) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

/** Derives the PBKDF2 hash for a candidate password against a parsed spec. */
function derive(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, iterations, KEY_LENGTH, "sha512", (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Timing-safe password verification against the configured hash. */
export async function verifyPassword(candidate: string): Promise<boolean> {
  const spec = config.dashboardPasswordHash ? parsePasswordHash(config.dashboardPasswordHash) : null;
  if (!spec) {
    log.error("ADMIN", "Dashboard login attempted but DASHBOARD_PASSWORD_HASH is missing or malformed.");
    return false;
  }
  const derived = await derive(candidate, spec.salt, spec.iterations);
  // Both sides are exactly KEY_LENGTH here — compare is constant-time.
  return timingSafeEqual(derived, spec.hash);
}

// ------------------------------------------------------------------
// Sessions: hashed-token -> { createdAt, csrf }
// The MAP KEY is the SHA-256 of the cookie token, so a memory dump
// can't be replayed as a valid cookie.
// ------------------------------------------------------------------
interface Session {
  csrf: string;
  createdAt: number;
}

const sessions = new Map<string, Session>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(): { token: string; csrf: string } {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  sessions.set(tokenKey(token), { csrf, createdAt: Date.now() });
  return { token, csrf };
}

export function dropSession(token: string): void {
  sessions.delete(tokenKey(token));
}

/** Validates a session token; returns its CSRF token, or null if invalid/expired. */
export function sessionCsrf(token: string | undefined): string | null {
  if (!token) return null;
  const session = sessions.get(tokenKey(token));
  if (!session) return null;
  if (Date.now() - session.createdAt > config.dashboardSessionTtlMs) {
    sessions.delete(tokenKey(token));
    return null;
  }
  return session.csrf;
}

/** Sweeps expired sessions (called from the server's periodic timer). */
export function sweepSessions(): void {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.createdAt > config.dashboardSessionTtlMs) sessions.delete(key);
  }
}

// ------------------------------------------------------------------
// Login rate limiting: per-IP strike counter with lockout.
// ------------------------------------------------------------------
const MAX_FAILURES = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

const failures = new Map<string, { count: number; lockedUntil: number }>();

/** True when this IP is currently locked out. */
export function isLockedOut(ip: string): boolean {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  if (entry.lockedUntil !== 0 && entry.lockedUntil <= Date.now()) failures.delete(ip);
  return false;
}

export function recordFailure(ip: string): void {
  const entry = failures.get(ip) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILURES) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0;
    log.warn("ADMIN", `Dashboard login locked out for ${ip} after ${MAX_FAILURES} failures (${LOCKOUT_MS / 1000}s).`);
  }
  failures.set(ip, entry);
}

export function clearFailures(ip: string): void {
  failures.delete(ip);
}

/** Best-effort client IP (localhost-only server: this is precise enough). */
export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/** Safely decodes one URL-encoded component; malformed sequences
 *  (truncated UTF-8, stray %, bad hex) decode to a replacement
 *  character instead of throwing — hostile or buggy input must
 *  never crash the request handler. */
function safeDecode(component: string): string {
  try {
    return decodeURIComponent(component.replace(/\+/g, " "));
  } catch {
    return "\u{FFFD}";
  }
}

/** Parses a URL-encoded form body (application/x-www-form-urlencoded, capped). */
export function parseFormBody(raw: Buffer): Map<string, string> {
  const params = new Map<string, string>();
  const text = raw.toString("utf8");
  for (const pair of text.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = safeDecode(pair.slice(0, eq));
    const value = safeDecode(pair.slice(eq + 1));
    params.set(key, value);
  }
  return params;
}
