### Workspace pane widths change after reload

- **What happened:** A pane with limits outside 240–640 px could not restore its saved width. Resize separators also announced the default width before hydration, even when SSR restored another width.
- **Root cause:** Persistence used the default pane limits as its storage envelope, and separator markup ignored the initial layout state.
- **Error class:** State lost on navigation or reload; server render vs. mount.
- **Guard:** `advanced-layout.render.test.tsx` checks the 160–960 px storage envelope. `workspace-levels.render.test.tsx` checks restored separator values. `workspace-levels.browser.test.ts` compares pane, head, and separator geometry before and after hydration with a saved cookie.
