# Syndicate Bot — v1.0.1

A polished Discord bot by **Ranajoy Roy**: utility, fun ("Coolsies"),
moderation, admin, and developer tiers — built with discord.js +
TypeScript on a real SQL database.

**v1.0.1 — the release the audits earned.** Six betas, five internal
audit cycles, then **three more adversarial post-1.0 cycles** (each
re-auditing the previous cycle's fixes) — every confirmed finding
fixed and pinned by a regression check that runs in CI. The command
reference below is the whole story — everything public on the prefix,
moderation/admin/developer tools on native slash.

It builds on v0.5.4's two-lane rule: **public commands live
exclusively on the prefix defined in your `.env`** (default `>`;
change it to `!` and every menu, usage line, and suggestion follows
instantly — nothing is hardcoded). **Slash is exclusively for
moderation, admin, and developer tools**, where Discord's structured
input and native permission gating belong. The prefix itself is
boot-validated: exactly one character, no whitespace, never `/` —
anything else refuses to start with a clear reason.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your values:
   ```
   cp .env.example .env
   ```
   - `DISCORD_TOKEN` — your bot's token
   - `CLIENT_ID` — your application's client ID
   - `DEV_GUILD_ID` — (recommended) test server ID for instant slash registration
   - `OWNER_ID` — your Discord user ID; counted as a developer automatically
   - `DEVELOPER_IDS` — comma-separated user IDs trusted with `/boot`, joke management, etc.
   - `DEV_LOG_CHANNEL_ID` — (optional) lifecycle announcements + error embeds
   - `BOT_LOG_CHANNEL_ID` — (optional) **private** verbose operational feed
   - `PREFIX` — prefix for public commands (default `>`)
   - `DATABASE_FILE` — SQLite path (default `data/syndicate.db`)

   **Enable the privileged intents** in the [Developer Portal](https://discord.com/developers/applications)
   → your application → **Bot** → *Privileged Gateway Intents*:
   - **SERVER MEMBERS INTENT** — member lookups (`>userinfo`, moderation hierarchy checks)
   - **MESSAGE CONTENT INTENT** — the prefix command lane (`>help`, `>afk`, ...)

   The bot requests both at login; leaving them off makes Discord
   refuse the connection with `Used disallowed intents`.

3. Register the (moderation/admin/developer + a few utility) slash commands:
   ```
   npm run deploy-commands
   ```
   Run again whenever a slash command changes. Public commands live on `>` and don't need this.

4. Run:
   ```
   npm run dev          # dev, auto-restart on changes
   npm run build && npm start   # production
   ```

5. Test:
   ```
   npm test
   ```

The database (schema + migrations) is created automatically on
first boot — no manual SQL step.

## The two surfaces

| Surface | Who uses it | Why |
|---|---|---|
| The `.env` prefix (default `>`) | Everyone, for ALL public commands | Visible in chat, works everywhere, zero Discord UI lag |
| `/` slash | Moderators, admins, developers ONLY | Structured input (user pickers, durations) + Discord-native permission gating |

The split is **strict and loader-enforced**: a public command with a
slash builder refuses to boot the bot; `deploy-commands` refuses to
register one; privileged commands must be slash-only. The prefix
itself is boot-validated — exactly one character, no whitespace,
never `/` (which would collide with Discord's native slash).

Trying a slash-only command via the prefix (e.g. `>kick`) gets a
styled explanation with its correct usage — never silence. Unknown
prefix input gets a **starts-with lookup** (`>se` → serverinfo,
setnick, userinfo...) or a **typo suggestion** (`>halp` → "did you
mean **>help**?").

## Commands (v1.0.1)

### 🛠️ Utility — prefix only, open to everyone
`help`, `ping`, `bot`, `invite`, `changelog`, `suggest`, `afk`, `remindme`, `poll`, `userinfo`, `serverinfo`, `avatar`, `banner`, `timestamp`, `snowflake`, `roll`, `calculate` (aliases: `calc`, `math`; `whois`, `ui`; `av`, `pfp`; `ts`, and more).

### 🎉 Coolsies — prefix only, open to everyone
`dice`, `coinflip`, `8ball`, `choose`, `random`, `rate`, `rps`, `joke` — and `joke add/list/remove/edit/enable/disable` for developers (strictly trusted-ID-gated, never roles). Same for `8ball`'s response pool management.

### 🛡️ Moderation — slash only, requires the matching Discord permission
`/kick`, `/ban`, `/timeout`, `/warn add|list|clear`, `/purge`

### 🔧 Admin — slash only, requires Administrator
`/announce`, `/setnick`, `/slowmode`

### 🔑 Developer — slash only, trusted user IDs only
`/boot` — DMs you a private Reboot/Shutdown/Cancel panel.

## Persistence

SQLite (better-sqlite3, WAL mode, foreign keys on) is the single
authoritative store. Migrations run automatically on boot and are
append-only — never edit an applied migration. Repositories own all
SQL; services own business logic; commands only coordinate.

| Data | Table | Notes |
|---|---|---|
| AFK status | `afk` | per-guild, auto-cleared by activity or `>afk off` |
| Reminders | `reminders` | restored on every startup; a 60s sweep catches strays |
| Warnings | `warnings` | soft-capped at 25 active per user (oldest roll off, transactionally) |
| Suggestions | `suggestions` | SQL + human-readable `data/suggestions.txt` export |
| Jokes | `jokes` | enable/disable, usage counts, developer-attributed |

## Architecture

```
src/
  core/         config, logger (+ private-channel mirror), client
  commands/     utility/ coolsies/ moderation/ admin/ owner/
  events/       ready, interactionCreate, messageCreate, guildCreate, guildDelete
  handlers/     command + event loaders (load-time validation)
  lib/          embeds, validation, cooldowns, errors, permissions, confirm,
                safeMath, safeTimeout, safeError, suggest, help, format, invite, devlog
  services/     afk, reminders, warnings, suggestions, jokes  (business logic)
  repositories/ afk, reminders, warnings, suggestions, jokes  (SQL only)
  database/     client (WAL, migrations, integrity check)
  workers/      mathWorker (isolated /calculate thread)
  tests/        unit tests (npm test)
```

Command flow: **command → service → repository → database**. Nothing
else touches SQL.

## Safety model

- **Developer authorization** = hardcoded trusted user IDs (`DEVELOPER_IDS`), checked in code — roles can never grant it, so no other server's admin can ever control the bot.
- **Moderation** = shared `canModerate` hierarchy (no self/bot/owner/equal-or-higher targeting; bot role positioned high enough), re-verified *after* confirmation dialogs, not just before.
- **Every confirmation dialog** collects only the invoker's click, at most once (max:1 + settled guard).
- **`/calculate`** runs in an isolated worker thread with a 3-second kill timer + blocklist — the DoS vector was real and is dead.
- **All user text** passes sanitization (mass-mention breaking, invisible-character stripping, line-separator stripping, markdown-safe escaping) before any embed is built — including poll questions, options, and button labels. Empty-after-sanitize text is rejected, never stored.
- **Number inputs** are strictly decimal — hex (`0x10`), scientific (`1e3`), and underscore (`1_0`) forms are rejected.
- **Reminders** cap at 25 pending per user per guild; rate-limited deliveries retry instead of failing permanently.

## Development

- `npm test` — build + unit suite (parsers, cooldowns, validation, dice distribution, suggestion engine, regression pins)
- `npm run verify` — everything: strict typecheck, build, **40** unit tests, and **five** verification harnesses (**152** integration/attack + **68** embed-output + **24** lookup + **3** timer checks + dispatcher torture). Same loop CI runs on every push (GitHub Actions + GitLab CI included).
- [CHANGELOG.md](CHANGELOG.md) — every release's full history; `changelog` in-chat shows the recent highlights
- `verify_timer.mjs` — chained-timer regression (the >24.8-day setTimeout bug)
- `verify_lookup.mjs` — prefix lookup/suggestion scenarios
- `verify-dispatcher.mjs` — prefix dispatch edge-case torture
- `verify-integration.mjs` — full command + attack harness against a throwaway database
- `verify-embeds.mjs` — renders every embed the bot can produce and validates each against Discord's hard limits (6000/4096/1024/256/25)
- Load-time errors are intentional: a duplicate command name or missing metadata refuses to boot the bot instead of silently dropping it.
- Error taxonomy: every failure is one typed class, rendered by one shared dispatcher path — input mistakes never consume the cooldown (`cooldowns.refund()`).

## Project files

| File | What it is |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | Every release's full history — also shown in-chat via `changelog` |
| [SECURITY.md](SECURITY.md) | How to report vulnerabilities, what counts as one here |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The non-negotiables: verify loop, two-lane rule, error taxonomy, checklist |
| [LICENSE.md](LICENSE.md) | Private — **not for public use** |
| [.github/](.github/) + [.gitlab/](.gitlab/) | CI (both platforms), issue templates, PR/MR templates, CODEOWNERS |

## License

Private — **not for public use**. See [LICENSE.md](LICENSE.md).

## What's next

- Per-guild feature configuration
- More Coolsies (trivia, would-you-rather) on the now-solid framework
- Suggestion review workflow (pending/approved/rejected) surfacing to admins
- Backup/restore tooling for the database
