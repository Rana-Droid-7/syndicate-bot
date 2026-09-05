# Contributing

This is a private project by Ranajoy Roy — contributions are by
invitation. If you're an authorized collaborator, this is the loop.

## The non-negotiables

1. **`npm run verify` is green before you push.** CI runs the exact
   same loop on both GitHub and GitLab; a red local run means a red
   branch.

2. **The two-lane rule is absolute.** Public commands (utility,
   coolsies) are prefix-only — no slash builders, no `execute()`.
   Privileged commands (moderation, admin, owner) are slash-only.
   The loader, `deploy-commands`, and CI all enforce it; don't fight
   the fence.

3. **Architecture layers: command → service → repository →
   database.** Commands coordinate, services own business logic,
   repositories own SQL. Nothing else touches the database.

4. **Errors: throw taxonomy classes, never reply internally.**
   `UserInputError`, `PermissionError`, `ContextError`,
   `CooldownError`, `DatabaseError` — the dispatcher renders them
   identically everywhere and refunds the cooldown on input
   mistakes. A command that catches its own input errors and replies
   is a bug (three audit cycles removed every instance).

5. **User text passes `sanitizeEcho`/`safeBoldText` before any
   embed is built.** If the sanitized result can be empty, use
   `sanitizeEchoOrReject`. Length-validated input gets
   sanitize-then-truncate ordering (sanitization expands text —
   the raw length check lies).

6. **Migrations are append-only.** Never edit an applied migration;
   add a new entry to `MIGRATIONS` in `src/database/client.ts`.

## Adding a command

1. Create `src/commands/<category>/<name>.ts` exporting a default
   `Command`. Required metadata: `category`, `surface`, `usage`
   (prefix-free for prefix commands), `description` (one line,
   under 100 chars), `cooldownSeconds`, `prefixNames`. Add
   `details` + `examples` — the help system renders them.
2. Prefix commands: implement `prefixExecute(message, args)` — args
   arrive quote-parsed, don't re-join and re-split them.
3. Slash commands: add `data` (SlashCommandBuilder) + `execute()`,
   with `setDefaultMemberPermissions` AND an in-code permission
   check (the Discord gate is UI convenience, not the boundary).
4. Destructive actions go through `confirmAction` and re-validate
   with fresh fetches after the confirm click.
5. Run `npm run deploy-commands` if you touched anything slash-side.

## Adding a check

Found a bug? Fix it, then pin it — a fix without a regression check
is a fix that silently comes back. Checks live in:

- `src/tests/unit.test.ts` — pure logic
- `verify-integration.mjs` — command behavior against a throwaway DB
- `verify-embeds.mjs` — rendered output vs Discord's hard limits
- `verify-dispatcher.mjs` — prefix dispatch torture

When you add checks, assert the **exact contract** (error class,
field values, rendered shape) — never a disjunction that passes
either way. Two vacuous checks from earlier cycles are documented
in the v1.0.1 changelog as cautionary tales.

## Commit style

`type(scope): summary` — e.g. `fix(audit-r3): output-shape
verification`, `feat(coolsies): trivia command`. The CHANGELOG is
maintained per release, not per commit.

## The audit habit

This project's quality comes from adversarial cycles: re-read your
own fixes, empirically confirm suspicions with a repro script
before changing code, verify rendered output (not just behavior),
and check cross-file relations (aliases ↔ usage ↔ help ↔
suggestion candidates ↔ deploy set). `npx tsc --noEmit
--noUnusedLocals --noUnusedParameters` is a cheap pre-push
dead-code sweep.
