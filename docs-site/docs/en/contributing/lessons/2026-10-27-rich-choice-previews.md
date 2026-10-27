### Choice previews must preserve the action's existing behavior

- **What happened:** Failed consequence reads blocked sender switching and moves, and a single unreadable file stopped every destination preview. Refreshing card details repeatedly reloaded wormhole previews.
- **Root cause:** Optional previews became action prerequisites, source failures escaped the per-entry boundary, and preview reads followed unrelated live revisions.
- **Error class:** Optional enrichment changes action availability.
- **Guard:** `MailSenderSelect.behavior.test.tsx`, `WormholeSelect.behavior.test.tsx`, `MoveDialog.behavior.test.tsx`, and `destination-previews.test.ts` exercise unavailable previews, partial selections, first-use storage, and refresh behavior. `wormholes.test.ts` bounds dependency examples; `access.test.ts` covers aggregate counts and provider boundaries.
