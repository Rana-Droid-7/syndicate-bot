# Syndicate Bot — v0.5.3-beta

A polished Discord bot by **Ranajoy Roy**: utility, fun ("Coolsies"),
moderation, admin, and developer tiers — built with discord.js +
TypeScript on a real SQL database.

v0.5.3 is the **help & content overhaul**: every command now carries
a proper one-line description plus a rich `>help <command>` guide
(what it does, how it behaves, tips); category pages and detail pages
rebuilt around them; `>help typo` gets a smart "did you mean". The
8-ball grew a full management suite (`>8ball add/list/remove/edit/
enable/disable`, exactly like `/joke`) with its own database-backed
response pool — and both the joke and 8-ball collections ship
preloaded.

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
| `>` prefix | Everyone, for public commands | Visible in chat, works everywhere, zero Discord UI lag |
| `/` slash | Moderators, admins, developers | Structured input (user pickers, durations) + Discord-native permission gating |

Trying a slash-only command via `>` (e.g. `>kick`) gets a styled
explanation with its correct usage — never silence. Unknown prefix
input gets a **starts-with lookup** (`>se` → serverinfo, setnick,
userinfo...) or a **typo suggestion** (`>halp` → "did you mean
**>help**?").

## Commands (v0.5.2-beta)

### 🛠️ Utility — `>`, open to everyone
`help`, `ping`, `bot`, `invite`, `changelog`, `suggest`, `afk`, `remindme`, `userinfo`, `serverinfo`, `avatar`, `banner`, `timestamp`, `snowflake`, `roll`, `calculate` — plus right-click **User Info** and **Avatar** context commands.

### 🎉 Coolsies — `>` and `/`, open to everyone
`dice`, `coinflip`, `8ball`, `choose`, `random`, `rate`, `rps`, `joke say` — and `joke add/list/remove/edit/enable/disable` for developers (strictly trusted-ID-gated, never roles).

### 🛡️ Moderation — slash-only, requires the matching Discord permission
`/kick`, `/ban`, `/timeout`, `/warn add|list|clear`, `/purge`

### 🔧 Admin — slash-only, requires Administrator
`/announce`, `/setnick`, `/slowmode`

### 🔑 Developer — slash-only, trusted user IDs only
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
- **All user text** passes sanitization (mass-mention breaking, invisible-character stripping, markdown-safe escaping) before any embed is built.

## Development

- `npm test` — build + unit suite (parsers, cooldowns, validation, dice distribution, suggestion engine)
- `npm run verify` — everything: typecheck, build, unit tests, and all four verification harnesses. Same loop CI runs on every push (GitHub Actions + GitLab CI included).
- `verify_timer.mjs` — chained-timer regression (the >24.8-day setTimeout bug)
- `verify_lookup.mjs` — prefix lookup/suggestion scenarios
- `verify-dispatcher.mjs` — prefix dispatch edge-case torture
- `verify-integration.mjs` — full command + attack harness against a throwaway database
- Load-time errors are intentional: a duplicate command name or missing metadata refuses to boot the bot instead of silently dropping it.

## License

Private — **not for public use**. See [LICENSE.md](LICENSE.md).

## What's next

- Per-guild feature configuration
- More Coolsies (trivia, would-you-rather) on the now-solid framework
- Suggestion review workflow (pending/approved/rejected) surfacing to admins
- Backup/restore tooling for the database
