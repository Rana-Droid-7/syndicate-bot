<!--
Thank you for the PR. Before requesting review, confirm:
-->

- [ ] `npm run verify` is green locally (typecheck + build + 40 unit + 165 integration + 76 embed + 25 lookup + 3 timer + dispatcher)
- [ ] No new package dependencies without discussion (three cycles were spent removing dead ones)
- [ ] Public command? Prefix-only, no slash builder. Privileged command? Slash-only with in-code permission checks.
- [ ] Errors throw taxonomy classes to the dispatcher — nothing catches its own input errors and replies internally
- [ ] User text passes sanitization before any embed/button is built; length-validated paths use sanitize-then-truncate
- [ ] New SQL goes through a repository; new schema changes are append-only migrations
- [ ] Bug fixes carry a regression check (unit / integration / embed harness) asserting the exact contract
- [ ] `npm run deploy-commands` run if any slash builder changed

## What changed and why

<!-- For multi-part changes: reference the audit finding / issue if applicable -->
