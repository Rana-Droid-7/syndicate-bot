/** Formats a millisecond duration as "1d 4h 32m 10s" (skips zero leading units). */
export function formatDuration(ms: number): string {
  // Guard against negative inputs (clock skew, "since" in the
  // future) — without this, a negative duration renders as garbage
  // like "-1d -1h -1m -5s". Anything at or below zero is "0s".
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

/** Formats a byte count as a human-readable MB string. */
export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

/**
 * Builds a Discord dynamic timestamp tag. Discord renders this
 * client-side in each viewer's own local timezone and locale —
 * no per-user timezone handling needed on our end.
 */
export function discordTimestamp(unixSeconds: number, style: TimestampStyle = "f"): string {
  return `<t:${unixSeconds}:${style}>`;
}
