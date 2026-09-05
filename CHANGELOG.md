# Changelog

All notable changes to Syndicate Bot are documented here. In-chat, use `>changelog` — it shows the most recent releases from this same history.

## v0.5.2-beta — 2026-09-05 (hardening + repo round)

Security, consistency, and repository polish. No behavior regressions — the full verification loop (build, typecheck, 33+ unit tests, 4 harnesses) passes.

### Security / hardening
- **Shared error mapper** (`lib/errors.ts` → `mapErrorToReply`): both dispatchers (slash + prefix) now map the taxonomy through one function — a new error type or message tweak can never drift between surfaces, and `DatabaseError` now devlogs on BOTH surfaces (the slash path previously swallowed it).
- **Info-leak hardening across every log surface**: new `lib/safeError.ts` — `errorDetail()` (censored, fence-safe, capped) replaces every raw `String(error)` in devlogs, the event-handler wrapper, and the crash embed. The private log mirror sanitizes control characters and censors token-shaped secrets before a line ever queues.
- **User-facing failure embeds** (kick/ban/timeout/purge/announce/slowmode) now use `safeErrorText()` — short API reason only, never raw internals.
- **Moderation TOCTOU closed**: kick/ban/timeout re-fetch the ACTOR and the BOT MEMBER (not just the target) after the confirmation wait — an invoker demoted or a bot role moved during the 30s dialog no longer acts on stale authority.
- **`/calculate` memory bombs**: the math worker now runs with hard heap limits (128 MB old-gen) — huge-matrix payloads crash the worker (surfaced as a clean error) instead of OOMing the whole process before the 3s kill fires.
- **Gateway crash guard**: the client installs an `error` listener — a transient WS/gateway error can no longer take the process down (Node throws on unhandled `error` events).
- **`/rps` buttons**: only the invoker's clicks count, enforced in the async collector *filter* (rejections never consume the `max:1` slot — a stranger's click can't lock the invoker out).
- **Dispatch log cap**: prefix dispatch logs cap at 8 args / 300 chars — a pasted wall of text no longer dumps into the log mirror.

### Consistency
- `>avatar`, `>banner`, `>userinfo`, `>rate` all use the shared `mentionToId`/`isSnowflake` validators (four hand-rolled copies removed).
- `suggest-utils.ts` merged into `suggest.ts` (single-consumer helper file gone).
- `DatabaseError` handling identical on both surfaces (via the shared mapper).

### Infrastructure / repo
- **`npm run verify`** — one command runs the whole verification loop (typecheck, build, unit tests, 4 harnesses).
- **CI for GitHub and GitLab** (`.github/workflows/ci.yml`, `.gitlab-ci.yml`) — same loop on every push/PR, no credentials needed.
- **`LICENSE.md`** — private, not-for-public-use license (no distribution, no public hosting, warranty disclaimer).
- **`.editorconfig`**, GitHub issue templates (bug + feature).
- `DATABASE_FILE` resolves against the project root — any CWD works.
- **README** updated: real command inventory (rps included), `safeError` in the lib list, `npm run verify`, license pointer.

### New
- **`>rps` / `/rps`** — rock-paper-scissors: instant on the prefix, clickable button duel on slash with invoker-only buttons.

## v0.5.1-beta — 2026-09-05 (bug-hunt round 2)

Fifteen bugs found by a full-codebase audit, all fixed and regression-tested (33 unit tests + 101 integration checks).

### Fixed
- **`/poll` stranded above 15 minutes** — the closing edit used `interaction.editReply()`, but interaction tokens expire after 15 minutes, so any poll running 16–60 minutes never showed results and kept live buttons on a dead poll. Finalization now edits via the message object (bot token, no expiry).
- **`>suggest` / `>joke add` / `>joke edit` could crash on mention-heavy input** — the length check ran before sanitization, but sanitization EXPANDS text (a zero-width mention-breaker per `@here`/`@everyone`); ~83 mentions passed the check, expanded past the DB CHECK constraint, and the insert threw. Sanitize-then-truncate everywhere now, matching the reminder pipeline's proven pattern.
- **Reminders could double-deliver** — the delivery path marked the row delivered only after the network send completed, so the 60s safety sweep could re-select a still-pending row mid-send and ping the user twice. A synchronous in-flight guard now dedupes timer vs. sweep attempts per reminder.
- **`>afk off to lunch` cleared AFK instead of setting the reason** — "off"/"clear" is only an intent when it's the whole argument now.
- **`/warn add` footer claimed warnings were in-memory and lost on restart** — false since v0.5.0's SQLite migration; the footer now states they're persistent.
- **AFK mention notices could overflow the embed** — a message mentioning many long-reason AFK members exceeded the 4096-char description limit and the whole notice was lost. Notices are capped (10 per message, 3500-char budget) with an "…and N more" line.
- **`/boot` panel reboots dropped the last log-mirror batch** — the panel's shutdown path skipped the log-sink flush the signal-based path performs.
- **Crash cleanup closed the DB before disconnecting** — ordering now mirrors the graceful path (disconnect, then close storage).
- **Ctrl+C during startup did no cleanup** — SIGINT/SIGTERM handlers are registered before the slow boot steps (command load, login) instead of after.
- **`>choose` silently dropped options beyond 10** — now rejected with a clear error.
- **`/8ball` accepted whitespace-only questions** — trimmed like the prefix path.
- **`/ping` showed `-1ms` WebSocket latency before the first heartbeat** — renders "connecting…" honestly; the slash path no longer reports a bogus ~0ms roundtrip when the ack payload carries no timestamp.
- **Reminder timers kept test harnesses alive for minutes** — reminder timers are unref'd (the Discord connection, not a pending reminder, keeps the live process running).

### Changed
- **Leaving a server now prunes orphaned user rows** — FK cascades delete the guild's data but previously left the parent `users` rows behind forever; `guildDelete` now sweeps them.
- **Dead code removed** — `lib/usage.ts` (unused), duplicate `escapeMarkdownBold` in `format.ts`, unused `parseQuotedArgs` rest field, `reminders.pendingForUser`, `suggestions.setStatus`, `guildRepository.ensure`, and calculate's local code-block sanitizer (now shared).

### Tests
- 5 new unit regression tests (mention-expansion limits, afk-off parsing, choose cap, in-flight dedup semantics) and 9 new integration checks against a throwaway DB — suite now 33 unit tests + 101 harness checks, all passing.

## v0.5.0-beta — 2026-09-04

The engineering release: persistent storage, a new fun category, and the prefix-first interface.

### Added
- **SQL database (SQLite, WAL, foreign keys, migrations)** — the authoritative store. Schema: `guilds`, `users`, `afk`, `reminders`, `warnings`, `suggestions`, `jokes`, all constraint-backed (CHECK limits, FK cascades, partial indexes for hot queries). Migrations are append-only and run automatically on boot; a fresh database reaches the current schema purely through them, and `integrity_check` must pass before the bot connects to Discord.
- **New Coolsies category** — dice, coinflip, 8ball, choose, random, rate. Every response has personality (never a bare "4"), and every command is cooldown-gated.
- **Joke system** — `>joke say` / `/joke say` for everyone; `add/list/remove/edit/enable/disable` strictly for configured developer IDs (in-code check, never roles — a server admin can never gain it). Jokes persist with metadata (author, timestamps, enabled state, usage count); random selection happens in SQL so 5 or 5000 jokes cost the same lookup.
- **Per-user, per-guild, per-command cooldowns** — synchronous check-and-set so simultaneous invocations can never both pass; entries sweep lazily.
- **`>afk off`** — explicit clear, no more "send any message and hope".
- **Quoted-argument parsing** for prefix commands — `>remindme "in 2 hours" stretch my legs` works, with backslash escaping and graceful fallback on broken quotes.
- **Unit test suite** (`npm test`) — 28 tests: quoted parsing, duration parsing, validation bounds, markdown/mention sanitization, cooldown semantics, a 10,000-roll dice distribution check, and the suggestion engine. Two real production bugs (broken combined-duration parsing; a sanitization ordering bug that UN-DID the @everyone break) were caught by this suite on its first run.

### Changed
- **`>` is the primary interface.** Public commands live on the prefix; slash is reserved for moderation/admin/developer commands (structured input + native gating) and the handful of public commands where it genuinely helps (dice, coinflip, 8ball, choose, random, rate, jokes, help, ping, bot, invite, changelog, userinfo-family, roll, calculate, timestamp, snowflake, poll). `remindme`, `afk`, and `suggest` are prefix-only.
- **Everything persists now**: AFK (per-guild), reminders (restored on every startup — a reminder set before a restart fires after it; a 60s sweep guarantees strays still deliver), warnings (capped at 25 active per user, transactionally), suggestions (SQL + the human-readable `data/suggestions.txt` export kept in sync), jokes.
- **Command metadata is a typed model** — every command declares `usage`, `surface`, `cooldownSeconds`, `examples`; the loader validates all of it at boot and hard-fails on duplicates or missing pieces (this immediately caught a real `dice` alias collision during the release build).
- **Error taxonomy** (`UserInputError`, `PermissionError`, `ContextError`, `CooldownError`, `DatabaseError`, …) — commands throw richly; dispatchers map every type to a styled reply with correct usage attached. No stack traces in chat, no silent swallowing.
- **Layered architecture**: `commands → services → repositories → database`. All SQL lives in repositories; business logic in services; commands only coordinate. New `src/services/`, `src/repositories/`, `src/database/`.

### Fixed
- Combined duration parsing (`1h30m`) returned wrong results; now parses any descending unit combo correctly.
- Sanitization ran mention-breaking BEFORE invisible-character stripping — which stripped the very zero-width space that broke the mention, re-enabling @everyone pings through echoed text. Order fixed.
- `/roll`'s `dice` alias collided with the new `>dice` command — caught by load-time validation, alias removed.

### Removed
- The empty `games` category (replaced by Coolsies).
- In-memory AFK/warning stores (replaced by the database).

## v0.2.0-beta — 2026-09-04

The polish release: a full redesign of everything user-facing, plus
a reorganized codebase and live observability.

### 🎨 Help system — redesigned from scratch
- `/help` home page is now a branded **Command Center** overview card with per-category counts and descriptions.
- Category pages list every command with usage line, description, and prefix availability in one field each.
- **Per-command detail pages**: `/help <command>` (slash) or `>help <command>` (prefix) — exact usage lines, aliases, category, prefix availability, and a `<> required, [] optional` legend in the footer.
- Browseable select menu now lives 3 minutes instead of 2.

### ✍️ Invalid input — handled everywhere
- **Typo suggestions**: an unknown prefix command within 2 edits of a real one gets *"did you mean **/roll**?"* with the correct usage shown — random prose starting with `>` is still ignored.
- Unknown slash commands get a styled embed ("may have been renamed or removed... run /help") instead of a plain-text wall.
- Slash-only commands tried via the prefix (`>kick`, `>boot`, `>poll`, ...) get a clear "this is slash-only" explanation — previously silence.

### 🔒 Strict slash-only enforcement
- All moderation, admin, developer, and poll commands marked and enforced as strictly slash-only — prefix attempts get the explanation above, never a silent no-op.

### 📡 Private verbose-log mirror (new)
- `BOT_LOG_CHANNEL_ID` env var: mirrors every INFO+ log line (command dispatches, permission decisions, AFK changes, timer scheduling, moderation actions, ...) into a private channel in batched code blocks.
- Batched every 5s / 40 lines, hard-capped message size, silent-fail design — the mirror can never crash or block the bot. Queued lines flush on every shutdown path (signal, crash, /boot panel).

### 🗂️ Codebase reorganization
- New `src/core/` (config, logger, client — the foundation) split from `src/lib/` (feature helpers). All imports updated; project-root resolution fixed for the new depth.

### 🧹 Other fixes & polish in this release
- Poll close-race fixed: the final "Poll closed" edit is serialized after the last in-flight vote update, so a finished poll can never keep (or revert to) the live "Vote below" footer.
- `verify_timer.mjs` output improvements carried forward; timer tests 3/3.
- Removed the `/afk` startup crash (105-char description over Discord's 100 limit).

## v0.1.8-beta — 2026-09-04

### Added
- Right-click context commands: **User Info** and **Avatar** from the Apps menu on any user.
- `/poll` now supports up to 10 options, custom durations (1–60 min), and a closing countdown.
- `/userinfo` shows profile banners and badge emojis.
- `/serverinfo` shows the server banner, description, vanity invite, and a boost progress bar.
- New `/changelog` command and an Invite button on `/help` and `/bot`.
- **Lifecycle announcements in the dev-log channel:** the bot posts a 🟢 "Bot Online" embed on every startup and a 🔴 "Bot Going Offline" embed (with the reason and who requested it) on every shutdown path — `/boot` panel actions, SIGINT/SIGTERM process signals, and crashes.

### Changed
- **`/boot` redesigned as a single command with a DM control panel.** Replaces the old `/boot stop` / `/boot restart` subcommands: running `/boot` now DMs the invoking developer a private button panel — 🔄 **Reboot** / 🛑 **Shutdown** / ❌ **Cancel** — that expires after 60 seconds. The channel where `/boot` was run only shows a discreet ephemeral note. Reboot exits with code 1 so a process manager (PM2/systemd/Docker) brings the bot back; Shutdown stays down until started manually.
- **AI scaffolding removed** (dormant `src/commands/ai/` category, config block, env vars, help-menu entry). It'll return as a real feature later — until then there's no dead code pretending to be wired up.

### Fixed (v0.1.8-beta audit pass)
- `/warn add` now runs the same moderation hierarchy check as kick/ban/timeout (no self/owner/higher-role/bot targeting) and requires the target to be an actual member.
- `/poll` question and options are now length-capped so the results embed can never overflow Discord's limits.
- `>remindme` prefix path now caps reminder text at 300 chars (matching the slash path) — long reminders used to be accepted but silently fail at delivery time.
- AFK status is now per-guild instead of global — chatting in one server no longer wipes your AFK status (and leaks the reason) in another.
- AFK mention notifications now have a 60-second cooldown per channel to prevent spam amplification.
- `>afk` with no reason now toggles AFK off if you were already AFK.
- `/warn add` failure paths, poll input validation, and reminder delivery all give specific errors instead of generic ones.
- Invite link now requests `ViewChannel` (needed in servers that restrict channel visibility) and no longer over-requests `ManageRoles`, which no command uses.
- `deploy-commands` now detects duplicate command names locally with a clear error, instead of failing with a cryptic Discord REST error.
- Unknown/invalid targets in `>userinfo` now get the same clear "doesn't look like a valid ID" message as `>avatar`/`>banner`.
- Markdown in user-provided text (reminder text, AFK reasons, usernames, suggestions) no longer breaks embed formatting.
- Uncaught exceptions now trigger a clean graceful shutdown (with dev-log) instead of continuing in a possibly-corrupt state.
- Uncaught actor-fetch failures in moderation/admin commands now report a specific error instead of the generic dispatcher fallback.
- `/announce` and `/slowmode` now validate channel types before acting.
- Invalid dice notation in `/roll` now replies ephemerally, keeping errors out of the public channel.
- Consistent embed colors: successes render green, warnings yellow, errors red — across every command.
- Changelog entries longer than Discord's field limit now truncate on whole lines/emoji boundaries.

### Changed
- `verify_timer.mjs` rewritten to actually exercise the chained-timer path, not just plain `setTimeout`.
- Logger now documents every tag in use, with no trailing whitespace on data-less lines.
- Project root now has a `.gitignore` (`.env` was one `git init` away from being committed).
- This `CHANGELOG.md` now exists — `/changelog` previously pointed users to it while it was missing.

## v0.1.7-beta — 2026-09-01

### Fixed
- `/warn list` can no longer overflow Discord's embed limit — long lists truncate the oldest entries.
- AFK welcome-back now reports a clean duration instead of a broken relative timestamp.
- Unknown slash commands get an explanation instead of a silent failure.
- Migrated to the `clientReady` event ahead of discord.js v15.

## v0.1.6-beta — 2026-08-30

### Fixed (19 bugs from a full audit pass)
- **Critical:** `/calculate` was a one-command denial-of-service — expressions now evaluate in an isolated worker thread with a hard 3-second kill timeout, plus a fast-path blocklist for known-expensive patterns (including mathjs's colon range operator).
- **Critical:** `/remindme` broke silently for delays over ~24.86 days (Node's 32-bit setTimeout limit) — fixed with chained timers supporting the full 30-day cap.
- **Critical:** `/invite` link was missing permissions for `/ban`, `/timeout`, `/slowmode`, and `/setnick`.
- `client.destroy()` now awaited before `process.exit()` everywhere.
- Moderation targets re-fetched and re-validated after the confirmation wait.
- `/warn` capped at 25 warnings per user (oldest roll off).
- Missing `setMaxLength()` added to several fields.
- `/userinfo` roles field truncates safely.
- `>afk` double-message on AFK updates fixed.
- `/purge` confirmation prompt is now ephemeral.
- Event handlers get centralized try/catch + dev-log reporting.
- `/suggest` slash path empty-content check; suggestions log strips embedded newlines.
- `>remindme` prefix parser slicing bug fixed.
- `>avatar`/`>banner` invalid-target messages.
- Command loader warns on name collisions.
- Help category embeds cap at Discord's 25-field limit.
- `/poll` vote count flicker fixed by serializing updates.
- Migrated off deprecated `ephemeral: true` to `MessageFlags.Ephemeral`.

## v0.1.5-beta — 2026-08-28

First public beta. Slash + `>` prefix commands, moderation tier with confirmation dialogs, admin tier, developer tier (`/boot`), centralized logger, suggestion file logging, invite link with correct scopes.
