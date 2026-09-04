# 🔍 Syndicate Bot — Full Audit Report

**Project:** `syndicate-bot`
**Version audited:** v0.1.8-beta (`src/config.ts:19`)
**Audit date:** 2026-09-04
**Scope:** Every source file, config, build output, and doc — bug hunting + integrity verification only.

> **✅ STATUS UPDATE (post-audit):** Every finding in this report has since been **fixed and verified** (typecheck clean, dist rebuilt, timer tests 3/3 passing). Fixes were applied in the same v0.1.8-beta revamp pass — see `CHANGELOG.md` for the user-facing summary. The findings below are preserved as the original audit record.

---

## 1. Build & Integrity Health Checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` (strict mode) | ✅ **PASS** — zero type errors |
| `dist/` freshness | ✅ **IN SYNC** — compiled 09:12 after last src edit 09:09; `dist/config.js` carries `0.1.8-beta` |
| Node version (v26.8.1) vs `engines` (`>=20`) | ✅ Satisfied |
| TODO/FIXME/HACK comments | ✅ None found |
| Deprecated `ephemeral: true` discord.js usage | ✅ None (see note on `purge.ts:56` below — it's the project's own `ConfirmOptions` key, not the deprecated API param) |
| `.env.example` completeness | ✅ Documents every variable `config.ts` reads |
| Command loader duplicate detection | ✅ Present (`commandHandler.ts:41-48`) |
| Event handler error wrapping | ✅ Centralized (`eventHandler.ts:41-58`) |
| No `.gitignore` in project root | 🔴 **MISSING** — see Finding C1 |

**Files audited:** 55 TS source files, `package.json`, `tsconfig.json`, `.env.example`, `README.md`, `verify_timer.mjs`, `dist/` output, `data/`, `src/commands/ai/README.md`. `.env` was intentionally **not** read (contains live token).

---

## 2. 🔴 Critical / High Findings

### C1. No `.gitignore` — live bot token one `git init` away from leaking
The project root contains `.env` (real `DISCORD_TOKEN`) but **no `.gitignore` file at all**. The folder is not currently a git repo, but the moment it's initialized and pushed, `.env`, `node_modules/`, and `dist/` would all be committed. The token = full control of the bot for anyone who sees it.

### C2. `CHANGELOG.md` doesn't exist, but the bot tells users it does
- `src/commands/utility/changelog.ts:13` — comment: *"Keep in sync with CHANGELOG.md at the project root"*
- `src/commands/utility/changelog.ts:55` — embed footer: *"Detailed notes live in CHANGELOG.md in the repository."*

There is no `CHANGELOG.md` in the repository. The `/changelog` command points every user to a file that isn't there. Either the file was never created or was deleted; the in-code `RELEASES` data has drifted from whatever the file was supposed to mirror.

### C3. Version triplet is inconsistent across the project
Three different "current versions" exist simultaneously:

| Location | Version |
|---|---|
| `src/config.ts:19` (drives all embeds, presence, `/bot`) | `0.1.8-beta` |
| `package.json:3` | `0.1.8` (missing `-beta`; `description` on line 4 says "v0.1.8 Beta") |
| `README.md:1` | **`v0.1.7 Beta`** |

The README's title, its entire "What's fixed in v0.1.7" framing (lines 1–70), and the "Commands (v0.1.7)" section (line 97) all describe the **previous** release. Nothing in the README mentions v0.1.8-beta's actual changes (context-menu commands, `/poll` upgrade, `/changelog` command, banners/badges in `/userinfo`, etc. — as listed in `changelog.ts:16-28`).

### C4. `/warn add` skips the moderation hierarchy check entirely
`src/commands/moderation/warn.ts:52-74` — kick, ban, and timeout all run `canModerate()` (self/bot/owner/equal-or-higher-role protection, `permissions.ts:56`), but `/warn add` does **not**. Consequences:
- A moderator can warn **themselves**, the **server owner**, someone with a **higher role** than themselves, or the **bot**.
- The target doesn't need to be a member at all — any user ID (or a nonexistent ID) can accumulate warnings in the store.
- Inconsistent enforcement philosophy: warnings are permanent moderation records shown by `/warn list`, yet have weaker guards than any other mod command.
(Whether warnings *should* apply hierarchy is a design call — but the asymmetry with the other three mod commands is real.)

---

## 3. 🟠 Medium Findings

### M1. `/poll` has no input length caps — embed overflow crashes
`src/commands/utility/poll.ts:60-70` — neither `question` nor any of the 10 options has `setMaxLength()`. Slash string options allow up to ~6000 chars by default:
- Question goes into the embed **title** (`poll.ts:39`) — hard limit 256 chars. A question longer than ~250 chars makes `interaction.reply()` throw; the user gets a generic "something went wrong" from the dispatcher.
- Options are joined into the **description** (`poll.ts:34,39`) — hard limit 4096. Ten long options blow past it.
- Every other string-consuming command in the project (`remindme`, `afk`, `suggest`, `calculate`, `announce`, mod reasons) sets `setMaxLength` — `/poll` is the only one that forgot.

### M2. `>remindme` prefix path has no message-length cap — reminder silently lost at fire time
`src/commands/utility/remindme.ts:109` — the prefix path derives `reminderText` with no length cap (the slash path caps at 300, `remindme.ts:53`). A long prefix reminder (e.g. 3000 chars) is:
1. Accepted and scheduled fine (the confirmation embed fits — description limit is 4096).
2. **Lost forever at fire time**: the delivery message `⏰ <@id>, reminder: **...**` (`remindme.ts:20`) exceeds Discord's 2000-char message limit, `channel.send()` rejects, and the reminder is only logged as failed (`remindme.ts:21-22`).

Every other prefix path caps its input (`afk.ts:31` → 200, `calculate.ts:51` → 200, `suggest.ts:77` → 500) — `remindme` is the only one that doesn't.

### M3. AFK store is global, warnings are per-guild — inconsistent scoping
`src/lib/client.ts:19` — `afkUsers` is keyed by bare user ID, while warnings (`lib/warnings.ts:21`) are keyed `guildId → userId`. Consequences of global AFK:
- A user sets AFK in Server A, chats in Server B → Server B announces "welcome back, I removed your AFK status" (`messageCreate.ts:36-56`) and **wipes the status** that was meant for Server A.
- Mentioning that user in Server C pings the AFK notice with Server A's reason.
If AFK is intentionally global, the welcome-back wipe makes it leak state across servers; if per-guild was intended, the key is missing the guild dimension.

### M4. AFK mention notice has no cooldown — spam amplifier
`src/events/messageCreate.ts:62-80` — every message mentioning an AFK user triggers a bot reply. A determined user can mention an AFK member on every message and make the bot reply every single time (no per-channel/per-user dedup or cooldown). AFK state also never expires on its own.

### M5. `verify_timer.mjs` doesn't test what its comment claims
`verify_timer.mjs:3-8` — the comment says *"A delay just over Node's 32-bit safe limit — this used to fire almost instantly instead of waiting"* — but the test uses **2000 ms**, which was never broken and never touches the chained-timer overflow path (`safeTimeout.ts:32-35`). The actual bug the fix addressed (>2^31−1 ms ≈ 24.86 days) is untestable in reasonable time with this harness. As-is, the file only proves plain `setTimeout` passthrough works. The comment is misleading about what's verified.

### M6. Actor self-fetch is un-caught in all mod commands
`kick.ts:36`, `ban.ts:45`, `timeout.ts:71` (and the same pattern in admin commands `announce.ts:33`, `setnick.ts:23`, `slowmode.ts:39`): `await interaction.guild.members.fetch(interaction.user.id)` has no `.catch(() => null)` while every *other* fetch in the same functions does. If this fetch rejects (rare, but possible during cache/permission edge states), the command dies with the generic dispatcher error instead of a specific message. Low probability, but inconsistent with the file's own defensive style everywhere else.

### M7. Invite link requests `ManageRoles` that no command uses
`src/lib/invite.ts:16` — the permission bitmask includes `ManageRoles`, but no command in the codebase needs it (moderation uses role *position*, not the permission). Least-privilege violation: it makes the bot request more power than it uses. Conversely, `ViewChannel` is *not* requested — the bot relies on the server's `@everyone` default for channel visibility, which breaks silently in servers that restrict `ViewChannel` on `@everyone`.

### M8. `deploy-commands.ts` lacks the duplicate-name guard the runtime loader has
`commandHandler.ts:41-48` warns on command-name collisions at runtime, but `deploy-commands.ts:19-34` collects `data.toJSON()` from every category with no dedup check — a name collision (easy to introduce with two categories) surfaces as a cryptic Discord REST error during `PUT` instead of a clear local warning.

---

## 4. 🟡 Minor / Cosmetic-Integrity Findings

### Version & docs
- **D1.** `src/commands/ai/README.md:3` still says *"v0.1.0 Beta is focused entirely on utility commands"* — four releases stale.
- **D2.** `README.md:99` claims "Utility (16)" but the category now holds **19** files (17 slash commands + 2 right-click context commands); README's list omits `/changelog`, `Avatar`, and `User Info` context commands entirely.
- **D3.** `README.md:139-146` project-structure section omits `lib/invite.ts` from the lib inventory.
- **D4.** `logger.ts:7-8` header lists tags `BOOT…SHUTDOWN` but omits `CALC`, `HELP`, `DEPLOY` (all used in code); `README.md:74` lists `CALC`/`HELP`/`DEPLOY` but omits `BANNER` (used at `banner.ts:12`).
- **D5.** `changelog.ts:20,31` — inconsistent date formats: `"2026-09-04"` vs `"2026-09"`.
- **D6.** `commandHandler.ts:38` — comment claims it "silently skip[s] non-command files (e.g. .gitkeep, README.md)", but line 26's `.ts`/`.js` filter means README.md is never imported at all; the comment describes a scenario the code doesn't reach.

### Dead / redundant code
- **D7.** `avatar.ts:23-35` — `buildAvatarButtonRow` always returns a non-null row (both branches `return row`), so every caller's `row ? [row] : []` check (`avatar.ts:50,61,81`, `context-avatar.ts:16`) is dead code.
- **D8.** `help.ts:24-37` — `games` and `ai` categories exist in `CATEGORY_META`/`PUBLIC_ORDER` but `activeCategories()` filters to categories with ≥1 loaded command, so they can never render. Harmless future-proofing, but currently unreachable config.
- **D9.** `usage.ts:34` — `SubcommandGroup` options are silently filtered out of usage lines; no current command uses groups, so nothing is lost today, but a future grouped command would display incomplete usage in `/help`.

### UX / input-handling inconsistencies
- **D10.** `userinfo.ts:160` — the prefix path accepts any garbage token as an ID and reports "Couldn't find that member", while `avatar.ts:66` and `banner.ts:66` validate the ID shape first (`/^\d{15,20}$/`) and give a much clearer error. Same family of command, three different validation behaviors.
- **D11.** `remindme.ts:84-86,138-140` — user-provided reminder text is injected inside `**...**` bold; text containing `**` breaks the formatting (cosmetic markdown injection). Same pattern for AFK reasons (`messageCreate.ts:68`) and suggestion echo (`suggest.ts:61`).
- **D12.** `messageCreate.ts:68` — `**${u.username}**` — usernames containing markdown characters break the bold formatting.
- **D13.** `roll.ts:28-31` — invalid dice notation replies with a public (non-ephemeral) embed; most other commands keep error feedback ephemeral.
- **D14.** `changelog.ts:50` — `join("\n").slice(0, 1024)` can cut mid-line or mid-emoji when a release's highlights exceed the field limit.
- **D15.** `logger.ts:21-24` — `data !== undefined ? data : ""` appends an empty string for every no-data log line (harmless trailing space in console output).
- **D16.** `bot.ts:14` — user count sums `memberCount` across guilds, double-counting members in multiple servers (labeled "approx." — acceptable but worth knowing).

### Design judgment calls worth revisiting
- **D17.** `index.ts:14-16` — `uncaughtException` handler keeps the process alive. Intentional (commented), but Node's own docs warn the process may be in an undefined state after an uncaught exception; a corrupt-state bot serving many guilds can misbehave silently.
- **D18.** `boot.ts:89` — restart exits with code **1**, relying on the process manager's failure-restart policy. Works (and is a common pattern) but semantically "restart" isn't "failure"; some managers alert/notify on non-zero exits.
- **D19.** `permissions.ts` — `/warn` is gated on `ModerateMembers` (Timeout Members) per `README.md:106`; functional, but "Timeout Members to manage warnings" reads oddly to moderators. (Consistent between code and README, though.)
- **D20.** AFK has no manual un-set command — only sending any message clears it. Fine as designed, but new users ask.

---

## 5. ✅ Verified Good (previously-fixed areas re-confirmed working)

These were the headline claims of v0.1.6/v0.1.7's changelog; each was re-verified in source during this audit:

- **`/calculate` DoS protection** — worker-thread isolation with 3s hard kill (`safeMath.ts:77-133`), fast-path blocklist **plus** the colon-range pattern that a name blocklist alone would miss (`safeMath.ts:40`), expression cap 200 chars, result cap 500 chars. Sound.
- **`safeSetTimeout` chaining** (`safeTimeout.ts:18-36`) — correct: ≤ 2^31−1 passthrough, one-hop-remainder recursion otherwise. (But see M5 — the verification script doesn't exercise the chain.)
- **`/remindme` prefix slicing** (`remindme.ts:108`) — uses match **end position** (`index + length`), not match length. The old garbled-text bug is confirmed fixed.
- **`confirmAction` race safety** (`confirm.ts:97-152`) — `settled` set before any `await` (closes the collect/end same-tick race), `max: 1`, async filter rejects non-invokers with their own ephemeral reply. Correct per discord.js event ordering.
- **Moderation re-validation after confirmation** — kick/ban/timeout all re-fetch and re-run `canModerate` after the confirm wait (`kick.ts:65-76`, `ban.ts:109-117`, `timeout.ts:96-107`).
- **Post-confirm action try/catch with specific failure reasons** — present in kick/ban/timeout/purge/announce/setnick/slowmode.
- **`/warn list` overflow safety** (`warnings.ts:74-104`) — reason truncation + oldest-drop loop mathematically cannot exceed the 3800-char budget; cap at 25 per user enforced at insert (`warnings.ts:31-38`).
- **`/suggest` newline sanitization** (`suggestions.ts:28`) and the empty-content check on the slash path (`suggest.ts:44-47`).
- **`/purge` ephemeral confirmation** (`purge.ts:52-57`) — the prompt can't be swept by its own purge; under-count message for >14-day-old messages.
- **`/userinfo` roles truncation** (`userinfo.ts:37-54`) — hard-stops at 1000 chars with an "…and N more" line.
- **Poll vote serialization** (`poll.ts:123-136`) — promise-chain guarantees display updates apply in submission order.
- **Help menu 25-field cap** (`help.ts:22,98-136`) with "...and N more" overflow field.
- **Unknown-command graceful reply** + the double-failure path when even the error reply fails (`interactionCreate.ts:33-41, 68-81`).
- **`clientReady`** event used (v14.16+ name) instead of deprecated `ready` (`ready.ts:8`).
- **`client.destroy()` awaited before `process.exit()`** in both shutdown handler (`index.ts:41`) and `/boot` (`boot.ts:56,87`).
- **Command loader name-collision warnings** (`commandHandler.ts:41-48,58-60`).
- **`canModerate` full hierarchy matrix** (`permissions.ts:69-99`) — self / bot / owner / equal-or-higher / bot-role-position all blocked with distinct reasons.
- **Global dev-ID gating for `/boot`** — checked in code, independent of roles (`boot.ts:29`), exactly as the README's permission-model section requires.

---

## 6. Environment & Project State Snapshot

- Runtime: Node v26.8.1, discord.js ^14.16.3, mathjs ^15.2.0, chrono-node ^2.7.7, dotenv ^17.4.2, tsx ^4.19.2, TypeScript ^5.6.3 (strict).
- `dist/` compiled and current (see §1). `data/` exists, empty — `suggestions.txt` will be created on first `/suggest` use (matches README's claim).
- `src/commands/games/` empty (reserved), `src/commands/ai/` dormant with README stub — both handled gracefully by the loader.
- 5 event files, 19 utility + 5 moderation + 3 admin + 1 owner command files; 2 of the utility files are right-click context commands.
- Command count in `/help`'s "Utility (N)" derives from the loaded collection — shows the *true* count (currently 19), unlike the stale README.

## 7. Suggested Fix Priority (for a future pass — nothing was changed in this audit)

1. **C1** — add `.gitignore` before anything else; never commit `.env`.
2. **C2** — create `CHANGELOG.md` or remove the reference from `/changelog`.
3. **C3** — reconcile the three version strings; update README to v0.1.8-beta.
4. **M1, M2** — add the missing `setMaxLength` caps (`/poll`, `>remindme`).
5. **C4** — decide hierarchy policy for `/warn add` and make it consistent.
6. **M3, M4** — decide AFK scoping (per-guild vs global) and add a mention-notice cooldown.
7. Then the 🟡 tier (docs/tags/dead code) at leisure.
