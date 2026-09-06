# Changelog

All notable changes to Syndicate Bot are documented here. In-chat, use `changelog` — it shows the most recent releases from this same history.

## v1.0.1 — 2026-09-05 (post-1.0 hardening: five adversarial audit cycles)

**The release the audits earned.** Five consecutive adversarial cycles against the 1.0.0 codebase (each re-auditing the previous cycle's fixes, empirically confirming every suspicion with repro scripts before touching code) surfaced 3 critical bugs, 10+ high/medium issues, and a long tail of nits — every one fixed and pinned by a regression check that runs in CI from now on.

### Critical (all confirmed with repro scripts before fixing)
- **`/warn list` overflow was inverted**: with more warnings than fit an embed, the bot showed the OLDEST records and hid exactly the recent ones moderators base decisions on — while the footer claimed "most recent shown". Overflow now drops from the oldest end; the single-entry fallback shows the newest.
- **`>changelog` was a guaranteed API error**: the full release list rendered a ~7,700-char embed against Discord's hard 6,000-char total cap — every invocation failed with *Invalid Form Body*. The builder now auto-fits (newest releases whole, older ones collapsed into a pointer line) with the budget enforced in code, not by hoping the array stays short.
- **The orphaned-user prune crashed guild-leave cleanup**: `pruneOrphanedUsers` checked every child table except `eightball` — a user whose only reference was an 8-ball response made the whole `DELETE` fail with a foreign-key constraint, skipping the sweep AND the in-memory AFK index drop that followed it. Both the missing clause and the ordering are fixed.

### Security / injection surfaces
- **Log-mirror fence injection**: the private bot-logs channel wraps batches in a code fence, but user args (e.g. `>suggest "``` @everyone"`) could break out of it — `sanitizeMirrorLine` now neutralizes triple backticks the same way `errorDetail` always has.
- **`>poll` never sanitized its text** — the one user-text command outside the pipeline: `@everyone` rendered in the embed title and button labels, invisible characters passed into labels. Question and options now pass `sanitizeEcho` before anything renders.
- **Invisible-only input crash family**: text that sanitizes to empty (zero-width chars, BOMs) violated DB `CHECK (length BETWEEN 1 AND N)` constraints as raw `SqliteError`s in `joke/8ball add`, `>remindme` text, and would have thrown on an empty poll title. New `sanitizeEchoOrReject()` gate: clean `UserInputError`s, or the AFK "AFK" fallback.
- **Strict number parsing**: `Number()` accepts `"0x10"` (16), `"1e3"` (1000), `"1_0"` (10) as integers — so `>joke remove 0x10` deleted joke #16. `parseIntInRange` now requires plain decimal digits.
- **Line-separator stripping**: `sanitizeEcho` now also removes U+2028/U+2029 (embed line-break injection).

### Durability
- **Reminder rate-limits are no longer permanent failures**: a Discord 429 (e.g. a boot-time burst of overdue reminders) used to mark the row `failed` forever. Rate-limited deliveries now stay `pending` for the 60s sweep to retry; only hard errors go terminal.
- **Reminders are capped at 25 pending per user per guild** (a 5s cooldown still allowed ~17k/day of boot-timer rows). The cap error is the real `UserInputError` — the first implementation faked the class with a reassigned `.name`, which failed every `instanceof` check downstream (generic error text, devlog spam, no cooldown refund). Found and fixed in the same cycle's self-review.

### Consistency / UX
- **Input errors no longer burn cooldowns, anywhere**: `joke`, `8ball`, `choose`, `random` (cycle 2) and `roll`, `rps`, `snowflake`, `userinfo`, `avatar`, `banner` (cycle 3) all replied input errors as success-shaped embeds inside the command — two parallel rendering paths that could drift, and every one consumed the cooldown on the mistake. All now throw taxonomy errors to the single dispatcher path, which renders them identically and refunds the cooldown (new `cooldowns.refund()`). Confirmed: `>roll 0d6` then `>roll banana` within 3s previously produced "you're using this command too quickly" instead of the notation help.
- **`CONFIRM` is mirrored**: the tag was missing from `MIRRORED_TAGS`, so every kick/ban/timeout/purge/warn-clear confirmation was invisible in the private bot-logs channel.
- **One dead-weight sweep**: `express`, `socket.io`, and the native `@napi-rs/canvas` (dashboard leftovers from 0.6.0–0.6.2) removed from dependencies; unused `errorEmbed` imports, `delayMs`, a `roll` parameter, and timestamp's dead `STYLE_CHOICES` table deleted (`noUnusedLocals` is now part of the local audit loop).

### Failsafes
- `getDb()` refuses access after `closeDb()` instead of silently re-opening the database file.
- `confirmAction` degrades on a missing message resource instead of hitting non-null assertions inside every moderation command.
- `guildDelete` drops the in-memory AFK index before the try block — a DB failure can't skip it.

### New verification infrastructure (wired into `npm run verify` + GitHub + GitLab CI)
- **`verify-embeds.mjs` (68 checks)** — renders every embed the bot can produce through discord.js' own serializer and validates each against Discord's hard limits (6,000 total / 4,096 description / 1,024 field value / 256 title / 25 fields), with maximal hostile inputs and the help visibility gates.
- `verify-dispatcher.mjs` now uses a self-cleaning throwaway database (the old `final.db` was recreated and abandoned on every run).
- **Counts**: 40 unit + 152 integration/attack + 68 embed + 24 lookup + 3 timer checks + dispatcher torture — plus relation scans (alias collisions, usage-vs-alias consistency, example dispatch, suggestion coverage, slash deployment parity, tag-mirroring coverage) run during the audit.
- Three harness checks that passed vacuously (a reply-or-throw disjunction, a masked-embed poll check, a replica-logic choose test) were rebuilt to assert the exact contracts.

### Cycle 4 — harness pollution + enforced consistency
- **Every `npm run verify` since the first release had been writing harness garbage into the production `data/suggestions.txt`** (637 polluted lines: mock users, `rm -rf` test payloads, stress walls). New `SUGGESTIONS_FILE` env override redirects harness writes to a self-cleaning throwaway; the real export was cleaned (genuine suggestions preserved) and pollution checks now run in CI.
- **Consistency is now enforced by CI, not just checked once**: package.json version == config.ts == README heading == bug-template placeholder; `.env.example` documents every env key config.ts reads (auto-derived from source); GitHub + GitLab CI verified to run every harness `npm run verify` runs.
- The last 16 hardcoded `>` log prefixes replaced with `config.prefix` — with `PREFIX=!`, log output follows the configured prefix like every user-facing surface always has.

### Cycle 5 — concurrency, rate-limit, and fuzz torture
- **Reminder 429 detection hardened**: structured signals first (`error.status === 429`, rate-limit error codes), message-text matching as fallback — API error wording can change between discord.js versions. Both paths are now pinned in CI (status-429 stays pending for the sweep to retry; hard errors go terminal).
- **Concurrency coherence proven**: 50 interleaved `/warn add`s land on exactly the 25-cap; 40 interleaved reminder creates land on exactly 25; AFK index never diverges from the DB; the suggestion export loses zero writes under 30-way concurrent appends; the log sink survives a 500-line hammer against a failing channel without crash or retry-loops.
- **Fuzz torture clean**: 5,000 chaos strings through the quote parser (zero crashes, 21ms), 39 hostile inputs through every prefix command via real dispatch (every failure is a taxonomy error — zero unhandled throws), math-worker boundaries (huge powers, infinity, complex results, precision edges) all contained by the sandbox, and the slash-lane error reply matrix (replied/defered × taxonomy/generic/database) routes exactly one correct reply per cell.
- Poll vote chains serialize without display regressions under 50 rapid votes; confirm dialogs resolve exactly once under late-click/expiry races.

### Runtime
- **Node.js floor raised to 24 (LTS "Krypton")**: engines, both CI images, and `@types/node` moved from 22 to 24. better-sqlite3@13 needs >=22 — 24 is the same requirement on the active LTS line with the longer security runway. No code changes were needed: the codebase is pure ESM on stable APIs (worker threads, node:test, better-sqlite3), and the full verify suite passes unchanged.

### Housekeeping
- README: privileged-intent setup step (first boot failed with `Used disallowed intents` for anyone following it), accurate verify counts, changelog/embed harness in the development section.
- Stale references cleaned: bug template's `0.5.1-beta` placeholder and "right-click context menu" option (that surface was removed in 0.5.4).

## v1.0.0 — 2026-09-05 🎉

**The first stable release.** Six beta versions, five strict audit cycles, one removed-and-relearning dashboard later — the architecture is settled, every surface is verified, and the version number drops its suffix for good.

### Why 1.0 now
- **Two-lane architecture, proven**: public commands live exclusively on the env-configured prefix (one character, boot-validated, dynamic everywhere); moderation/admin/developer tools live exclusively on native slash with Discord's permission gating. The loader enforces the split — violations refuse to boot.
- **Five full audit cycles**, each one adversarial against the last: bug hunts (15+ fixes), scenario testing (raw-socket floods, 30-way concurrency, spam matrices, hierarchy abuse), per-file manual confirmation, database contract verification, and import-graph validation (315 edges, all resolve).
- **A complete test pyramid**: 35 unit tests, 124 integration/attack checks, 24 lookup-engine checks, dispatcher edge-case torture, chained-timer regression — all wired into `npm run verify` and CI on both GitHub and GitLab.
- **Zero known defects** across the final three consecutive audit cycles.

### Final hardening (this release)
- **Context-command scaffolding fully excised**: the `UserContextCommand` type, loader branch, dispatcher routing, and help-menu renderings for right-click commands (removed from the product in 0.5.4) are gone from the codebase — dead branches deleted, not commented out.
- Stale comment on the command registry corrected (it described the pre-0.5.4 collection).
- Dead-code sweep round 6: `parseUserTarget`, `parseDuration` (tested but never used in production paths), `reminderConstants` removed; internal `say()` renamed `tellOne` for truth-in-code.

### The bot, in one paragraph
25 prefix commands across Utility (help, ping, bot, invite, changelog, suggest, afk, remindme, poll, userinfo, serverinfo, avatar, banner, timestamp, snowflake, roll, calculate) and Coolsies (dice, coinflip, 8-ball with a developer-managed response pool, choose, random, rate, rock-paper-scissors, jokes with a developer-managed collection) — every one with a proper description, a rich `help <command>` guide, cooldowns, and quote-aware parsing. Nine slash commands for the privileged lane: kick, ban, timeout, warn, purge (moderation), announce, setnick, slowmode (admin), boot (developer-only process control with a private DM panel). Everything persists in SQLite (WAL, FK cascades, CHECK-validated writes, append-only migrations); reminders survive restarts and deliver exactly once; logs mirror to a private Discord channel with secret-censoring; the calculator runs in a heap-limited worker thread with a hard kill timer; the invite link requests exactly the permissions the commands use. By **Ranajoy Roy**.

## v0.6.3-beta — 2026-09-05 (dashboard removed + joke streamlined)

### Removed
- **The experimental local dashboard is gone, entirely.** The `src/web/` module (server, auth, pages), `verify-dashboard.mjs` (its 43-check security harness), `scripts/hash-password.mjs`, the `DASHBOARD_*` config surface, `.env`/`.env.example` documentation, CI steps on both GitHub and GitLab, and the README section — all removed. A better dashboard design is planned for a future release; the two strict scenario-audit cycles it went through (and the hardening lessons from them) are preserved in the changelog history and will apply to the rebuild.
- `suggestionRepository.recent()` and `setStatus()` — dashboard-only consumers, removed with it (the future review workflow will reintroduce them).

### Changed
- **`joke` tells one now** — plain `joke` (no `say`) pulls a random joke; the management verbs (add/list/remove/edit/enable/disable) are unchanged and still developer-gated. Usage/examples/help updated everywhere; unknown subcommands get a pointer back to plain `joke`.

### Kept
- `lib/shutdown.ts` (the unified graceful-exit path) — it serves `/boot` and the OS-signal handlers.
- `warningRepository.totalActive()` — status reporting will need it regardless of UI.

## v0.6.2-beta — 2026-09-05 (two strict scenario-audit cycles)

Every category, command, and surface probed with usage/abuse/spam scenarios; raw-socket and concurrency attacks against the dashboard.

### Fixed
- **8-ball gate misparse**: questions that merely START with a management verb word (`8ball remove the doubt, will it work?`) were wrongly answered with "management is developer-only". The gate now triggers only on the management SHAPE — `list [page]`, `remove/edit/enable/disable <numeric id>`, or `add` + content; prose is always answered. Pinned with 6 new scenario tests.
- **Dashboard body-reader race**: oversized-body rejection could double-settle the read promise and logged an expected abuse condition as a full error stack. Rewritten with a single-settle finish; abuse now logs a clean warn (`Body too large` no longer stack-noises the console).
- **`hash-password` accepted whitespace-only passwords** (`"        "` hashed fine) — now trimmed and re-validated before hashing.
- **Login strike map grew forever** — expired lockouts and stale strike counters are now swept on the session-sweeper tick.
- **Dashboard `?notice=` param unbounded** — a hand-crafted URL could bloat the page; capped at 200 chars.
- **Malformed dashboard hash UX**: a present-but-malformed `DASHBOARD_PASSWORD_HASH` previously booted a dashboard that could never accept any password — now refuses to start with the exact expected format (previously only a *missing* hash refused).
- **Sub-second reminders** (`remindme "in 0.0001 seconds" x`) fired before the confirmation reply landed — now round up to one second.
- verify-dashboard.mjs: abandoned second-server scaffolding (dead import + stale port comment) removed.

### Verified by new scenario probes (all passing, most pinned in harnesses)
- Raw-socket abuse: 2.5MB body flood, absolute-form/asterisk request targets, mid-body RST — server survives all, no crash, no unhandled rejection
- 30-way concurrent dashboard requests: zero 5xx, all writes persisted, sessions intact
- Session fixation: token rotates on every login; malformed cookie values rejected cleanly
- Cooldown keys: 25 unique, aliases correctly share one key, zero collisions (re-verified after the 0.5.4 '?' bug class)
- canModerate matrix: all 6 hierarchy cases + owner override re-verified
- Seed data: 19+10 rows, no duplicates/mojibake, SQL apostrophe escapes intact
- Hash validation: truncated and low-iteration (<10k) hashes refused

## v0.6.1-beta — 2026-09-05 (dashboard polish + strict-audit round)

The dashboard grows up, then the whole project goes through another multi-cycle strict audit.

### Dashboard
- **Inline editing**: every joke and 8-ball response has an ✎ edit view (textarea with the current text) and a Save action — O(1) row lookup, content-length validated, empty saves refused cleanly.
- **Suggestion → implemented**: a third review state (★) alongside approve/reject, wired through the schema's existing status CHECK.
- **Richer status card**: jokes/responses totals, active warnings across all guilds, users currently AFK.
- **Hardening**:
  - **CSP** `default-src 'none'` (+ form-action 'self', base-uri 'none') — even a hypothetical escaping bug can't execute script; style-src inline-only because everything is server-rendered.
  - **HEAD /** health probe honoring auth (200 authed / 401 anonymous).
  - **Malformed-form crash fixed**: truncated UTF-8 / stray `%` in POST bodies threw 500s through decodeURIComponent — the new safeDecode decodes hostile input to a replacement character instead (caught by the harness before it ever shipped enabled).
  - Edit-form cleanup: stray hidden content field and unused `op` button removed.

### Strict-audit round (3 cycles)
- **package-lock.json was three releases stale** (0.5.3-beta) — resynced to 0.6.0-beta; version surfaces now include the lockfile.
- **README intro was stale** — still headlined v0.5.4's story under a v0.6.0 title; rewritten to lead with the dashboard.
- auth.ts: lying session comment fixed (`lastSeen` never existed), mid-file import hoisted.
- Typos/stale-refs/TODO sweeps: clean. Route inventory: every form action in pages.ts maps to a real server route.

### Tests
- Dashboard harness: 29 → **43 checks** — edit flow end-to-end (view → save → persisted → empty refused → ghost refused), implement verb, CSP/nosniff/DENY header assertions, HEAD auth, malformed-body resilience, oversized-body resilience.
- Full loop re-run clean: tsc, 37/37 unit, 119/119 integration, 24/24 lookup, 43/43 dashboard, dispatcher, timer.

## v0.6.0-beta — 2026-09-05 (local management dashboard)

The bot now hosts its own browser console for the operator.

### Dashboard
- **localhost management UI** at `http://127.0.0.1:3721` (opt-in): live status (servers, members, uptime, pending reminders), full **joke** and **8-ball response** management (add / disable / enable / remove), **suggestion review** (approve / reject), and **process control** (reboot / shutdown — identical semantics to the `/boot` panel).
- **Zero new dependencies** — pure `node:http`, no framework.

### Security model (layered)
- **Network**: binds `127.0.0.1` only — remote hosts cannot open a connection. Exposing it requires a deliberate `DASHBOARD_HOST` override AND a valid password hash.
- **Auth**: the password exists ONLY as a PBKDF2-SHA512 hash (120k iterations, 64-byte key) — generated by `npm run hash-password`, never plaintext in `.env`. Verification is timing-safe.
- **Rate limit**: 5 failed logins → 10-minute IP lockout (the correct password is also rejected during lockout).
- **Sessions**: 256-bit random tokens, SHA-256-hashed at rest, HttpOnly + SameSite=Strict cookies, 2-hour TTL, periodic sweep.
- **CSRF**: every state-changing POST requires the session-bound token; `X-Frame-Options: DENY`, `nosniff`, `no-store`, `no-referrer` headers.
- **Actions**: only operator verbs, executed through the SAME service layer the Discord commands use — no new SQL surface, no privilege path. All mutations logged to the mirrored ADMIN feed.
- **Refuses to boot** without a valid password hash — an unauthenticated dashboard is worse than none.

### Infrastructure
- `lib/shutdown.ts`: the graceful-exit path (reminder stand-down → log drain → disconnect → DB close) extracted into one shared function — `/boot` and the dashboard can never drift on cleanup ordering.
- `suggestionRepository` grew `recent()` and `setStatus()` — the review workflow the 0.5.2 audit flagged as "upcoming" now exists.
- **`verify-dashboard.mjs`** (29 checks): boots the real server and attacks it over real HTTP — auth gate, lockout, CSRF rejection, stored-XSS escaping (hostile suggestion + response payloads render escaped), action round-trips through the service layer, session lifecycle. Wired into `npm run verify` + both CIs.

### Upgrade notes
- New optional env vars: `DASHBOARD_ENABLED`, `DASHBOARD_PASSWORD_HASH`, `DASHBOARD_PORT`, `DASHBOARD_HOST` — all documented in `.env.example`. Disabled by default; nothing changes unless you opt in.

## v0.5.4-beta — 2026-09-05 (strict two-lane surfaces + env-prefix everywhere)

One prefix, one rule: **public commands live on the prefix (from `.env`, default `>`); slash is exclusively for moderation, admin, and developer tools.**

### Post-release strict-audit fixes (same day — three audit rounds)
- Nine commands (`bot`, `calculate`, `help`, `ping`, `roll`, `timestamp`, `serverinfo`, `snowflake`, `userinfo`) were missing their `name:` metadata after the surface conversion — typo suggestions never matched them, and they all shared one cooldown key (cross-locking each other). Fixed across two audit rounds: names restored, suggestion coverage verified at runtime (34/34), cooldown keys unique.
- `package.json` version had drifted (still 0.5.3-beta) — re-synced across all five version surfaces.
- The `COOLSIES` log tag was missing from the private-log mirror (and the logger's documented tag list) — every joke/8-ball/game operation now reaches the bot-logs channel.
- Two hardcoded `>` strings survived in user-facing text (`calc` usage reply, `afk` details) — now prefix-dynamic.
- `/bot` footer pointed at `/changelog`, which no longer exists — now points at the prefix command.
- Dead imports pruned across nine files (rate, suggest, help, setnick, slowmode, purge, warn); `suggest` now actually logs to the SUGGEST feed like every other command.
- **`lib/collection.ts`**: the joke and 8-ball management families (add/list/remove/edit/enable/disable — ~150 duplicated lines each) unified into one shared, developer-gated handler factory. One implementation, identical validation, sanitize-then-truncate, and error text everywhere; both commands plug in a service + nouns.

### The policy, enforced by the loader
- **Prefix validation at boot**: `PREFIX` must be exactly ONE character, not whitespace, not `/`. Anything else refuses to start with a clear reason ("PREFIX exceeds the character limit — it must be exactly ONE character..."). Change it to `!` (or `?`, `$`, whatever) in `.env` and every menu, usage line, typo suggestion, and footer follows instantly — nothing anywhere hardcodes `>`.
- **Public categories (utility + coolsies) are prefix-ONLY.** The loader hard-fails any public command carrying a slash builder; `deploy-commands` separately refuses to register one even if the loader somehow missed it. All 21 public commands converted; the two right-click context commands (Avatar / User Info) removed — public commands left the Apps menu.
- **Privileged categories (moderation/admin/owner) are slash-ONLY**, unchanged — Discord's structured input and native permission gating are part of their safety model.
- **`CommandSurface` dropped `"both"`** — the type now encodes the policy: `prefix-only | slash-only`.

### Prefix-free metadata, rendered live
- Every command's `usage` and `examples` are now stored **prefix-free** (loader-enforced — a `>`-prefixed usage string is a boot error). The help system, typo suggestions, and category pages render them with the live `config.prefix`, so the entire help surface flips with one `.env` edit. User-facing error messages inside commands were swept for hardcoded `>` too — all dynamic now.

### Rebuilt on the prefix
- **`poll` is prefix-native now**: `poll "question?" "opt1" "opt2" [minutes]` (quoted, multi-word friendly) or `poll lunch sushi ramen` (fast, single-word). Same live bar chart, one-vote-per-person buttons, auto-close with final tallies, 1–60 minutes. The 15-minute interaction-token trap is structurally gone — it edits via the bot token from the start.
- **`rps` button duel moved to the prefix**: plain `rps` opens the clickable duel (invoker-only buttons, 30s window); `rps rock` stays instant.
- **`joke` and `8ball`** are prefix-only — full management suites intact, developer-gated by trusted user IDs.

### Tests & harnesses
- 3 new unit tests for `parsePollArgs` (quoted/unquoted shapes, duration bounds, the "question that looks like a number" edge); suite at 37. Lookup-harness mocks updated to the new metadata shape. Full loop green: tsc clean, 37/37 unit, 111/111 integration, 24/24 lookup, dispatcher edge-cases all safe, timer 3/3.

## v0.5.3-beta — 2026-09-05 (help & content overhaul)

The help system, every command's documentation, and the 8-ball — rebuilt from scratch.

### Help system, rebuilt
- **Every command now documents itself.** A new required `description` metadata field (one-liner, enforced at boot — a command without one refuses to load) plus an optional `details` block: the rich, properly-written guide shown by `>help <command>`. All 34 command files carry both, written properly — what each command does, how it behaves, its limits, and tips.
- **Category pages redesigned** — every command now shows as `>name — description` with its usage line beneath. Scannable instead of a bare usage dump.
- **Detail pages rebuilt** — description/details prose up top, then Usage, Category, Available-as, Aliases, Examples, and a new **Cooldown** field. Context-menu commands get descriptions too.
- **Smart not-found**: `>help halp` now suggests the closest command ("did you mean **help**?" with the exact command to run), falls back to starts-with/contains matches with descriptions, and only then points at the menu. Same behavior on `/help`.
- The home card, category select menu, and visibility rules (admin/owner sections only for those who can use them) carry over unchanged.

### 8-ball, grown up
- **`>8ball` / `/8ball` is now a full suite**, mirroring `/joke`: `ask` (public), plus developer-only `add`, `list [page]`, `remove <id>`, `edit <id> "<new>"`, `enable/disable <id>` — identical subcommand shapes on both surfaces.
- Responses live in a new `eightball` database table (same schema family as jokes: author, timestamps, enabled state, usage counts; random selection happens in SQL inside one transaction with the counter bump).
- Prefix `>8ball <question>` without a subcommand still just asks — the smart dispatcher only treats explicit management words as subcommands.
- Sanitize-then-truncate ordering throughout (the mention-expansion lesson from v0.5.1, applied from day one).
- Every ask shows the response ID and pool size in the footer.

### Preloaded content
- **19 classic 8-ball responses** seeded via an idempotent migration (`002`) — a fresh database boots with a full pool, zero setup.
- **10 starter jokes** seeded the same way — `>joke say` works out of the box.

### Attribution
- The bot now credits **Ranajoy Roy** as its author — `/bot` (`>bot`), `package.json`, and LICENSE.md.

### Notes
- `>help` and the whole help chain now draw from the same metadata the loader validates — documentation and reality can't drift apart; a command missing its description is a boot error, not a silent hole in the menu.

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
