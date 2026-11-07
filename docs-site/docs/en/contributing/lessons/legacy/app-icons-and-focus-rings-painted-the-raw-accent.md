### App icons and focus rings painted the raw accent

- **What happened:** The color sweep found Mail summary links with `text-[var(--app-accent)]` (fixed in [#1543](https://github.com/k2b-dev/cloud/pull/1543)). Grids and Notebooks overview icons and rows used `color: var(--app-accent)` and `outline: 2px solid var(--app-accent)`; [#1559](https://github.com/k2b-dev/cloud/pull/1559) moved them onto `k2b-icon-tile` and the platform focus, so the check baseline is empty again. A light accent such as yellow falls below 4.5:1 as text. The focus ring changed per app instead of staying the platform focus.
- **Root cause:** `accent-mix` only caught mixes, so a direct read of the raw accent passed every check.
- **Error class:** Raw app accent as text or focus ring.
- **Guard:** `bun scripts/check.ts selection-tokens` (kind `accent-raw`) rejects `var(--app-accent)` in `color`, `outline`, `outline-color` and `border-color` declarations and in `text-`, `outline-`, `ring-` and `border-` utilities in app source. Backgrounds such as the Mail unread dot stay allowed. Tests: `scripts/checks/selection-tokens.test.ts`.
