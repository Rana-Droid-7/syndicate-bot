/**
 * Rate-limit detection for a failed Discord send. Structured signals
 * first — discord.js throws DiscordAPIError with .status (HTTP 429)
 * and/or .code (rate-limit responses carry specific codes); message-
 * text matching is the fallback because API error wording can change
 * between versions.
 *
 * Extracted here (v1.1.0) so reminder delivery and poll closeout share
 * ONE detector — the kind of parallel-implementation drift (two
 * detectors, one updated) this codebase structurally refuses elsewhere.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const e = error as { status?: unknown; code?: unknown; message?: unknown };
    if (e.status === 429) return true;
    if (typeof e.code === "string" && /^RATE_LIMIT/i.test(e.code)) return true;
  }
  const messageText = error instanceof Error ? error.message.toLowerCase() : "";
  return messageText.includes("rate limit") || messageText.includes("429");
}
