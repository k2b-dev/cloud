### The open row of a small v2 table had no tint

- **What happened:** On the v2 agent page (#4110) a key opens beside its table, and the table names it with `current`. The row got `aria-current`, but no tint: design QA measured white where the app's tint belongs.
- **Root cause:** `v2.css` scoped the tint of `tr[aria-current]` to `.k2-table[data-grid]`, the large table with `select` or `sticky`, although `current` is documented for every table with `rowKey`.
- **Error class:** A state style written inside one variant's selector, so the state shows only in that variant.
- **Guard:** `packages/accounts/src/frontend/agents/agent-screens.browser.test.ts` reads the background of the open key's row cells and expects the app's tint, in Chromium and WebKit.
