### A key cap marks its key twice

- **What happened:** The new profile menu showed its shortcut hint „Strg \“ in bold. Every `Kbd` in Cloud did the same, in menus, the command palette, and Help.
- **Root cause:** `.k2b-kbd__key` in `@k2b/ui` set `font-weight: 600` on top of the cap's ring and bottom edge, so the hint drew more attention than the entry it belongs to.
- **Error class:** A shared component stacks two emphasis cues where its shape already carries the meaning.
- **Guard:** `packages/ui/src/content/help-blocks.browser.test.ts` checks the cap's computed weight is 400 in light and dark panels.
