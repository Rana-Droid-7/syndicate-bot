import { CooldownError } from "./errors.js";

/**
 * Per-user, per-command, per-guild cooldowns. In-memory by design —
 * a cooldown is transient spam protection, not meaningful state,
 * so persistence would add cost for no benefit. All entries are
 * pruned lazily on check, keeping the map bounded by active users.
 *
 * The check-and-set is synchronous (single Map lookup), so two
 * simultaneous invocations of the same command by the same user can
 * never both pass — the second always rejects.
 */
export class Cooldowns {
  private readonly hits = new Map<string, number>(); // key -> unix ms when it expires

  private key(guildId: string | null, userId: string, commandName: string): string {
    return `${guildId ?? "dm"}:${userId}:${commandName}`;
  }

  /**
   * Throws CooldownError if the user is still cooling down; otherwise
   * records the hit and returns.
   */
  check(guildId: string | null, userId: string, commandName: string, cooldownSeconds: number): void {
    if (cooldownSeconds <= 0) return;

    const key = this.key(guildId, userId, commandName);
    const now = Date.now();

    // Prune this key if expired.
    const existing = this.hits.get(key);
    if (existing !== undefined) {
      if (existing > now) {
        const retryAfter = Math.ceil((existing - now) / 1000);
        throw new CooldownError(
          `You're using this command too quickly — try again in **${retryAfter}s**.`,
          retryAfter,
        );
      }
      this.hits.delete(key);
    }

    this.hits.set(key, now + cooldownSeconds * 1000);
  }

  /**
   * Removes a live cooldown hit — used when a command failed BEFORE
   * doing anything (validation/context/permission errors). A user
   * shouldn't burn their cooldown window on a typo retry.
   */
  refund(guildId: string | null, userId: string, commandName: string): void {
    this.hits.delete(this.key(guildId, userId, commandName));
  }

  /** Periodic sweep so inactive keys don't accumulate forever. */
  sweep(): void {
    const now = Date.now();
    for (const [key, expires] of this.hits) {
      if (expires <= now) this.hits.delete(key);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Shared singleton — the client owns it. */
export const cooldowns = new Cooldowns();
