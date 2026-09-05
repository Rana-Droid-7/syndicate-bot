# Security Policy

## Supported versions

Only the latest release (see [CHANGELOG.md](CHANGELOG.md)) receives
security fixes. Update before reporting.

## Reporting a vulnerability

**Do not open a public issue for anything security-relevant.**

Contact the maintainer (Ranajoy Roy) directly through Discord — the
same channel you use for everything else about this project. Include:

- A description of the issue and its impact
- Steps or a proof-of-concept (the command/input that triggers it)
- The bot version (`>bot`)

You will get an acknowledgment within a few days. Please avoid
publicly disclosing the issue until a fix is released.

## What counts as a security issue here

- Anything that lets a non-developer run developer-gated actions
  (`/boot`, joke/8-ball management) — the trusted-ID gate is the
  security boundary, not roles
- Token or secret leakage through logs, embeds, or the private
  mirror channel
- Injection into embeds/channels from user-controlled text
  (mass mentions, code-fence breakout, invisible-character spoofing)
- SQL injection through any command input (all repositories use
  positional binding — a bypass would be a finding)
- Crash-loop or DoS vectors reachable from public commands (the
  `/calculate` worker sandbox exists precisely because this class
  was real once)

## What does NOT

- Discord API outages, gateway disconnects, or rate limiting
- Bugs that need Moderator/Administrator permissions in a server
  you already control
- Missing features

## Handling

The project runs adversarial audit cycles; findings from past cycles
(including three post-1.0 cycles) are documented in
[CHANGELOG.md](CHANGELOG.md) with their fixes and regression checks.
