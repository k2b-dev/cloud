### A long v2 menu ran off the screen

- **What happened:** A `Menu` with 60 people (the people menu of a space) was cut off at the bottom of the screen at 1024 px and wider. Behind the "…" of a low row, the same menu started above the top of the screen.
- **Root cause:** `.k2-menu` capped its height at `100dvh - 16px`, the height of the whole screen. A menu opens beside its button, so the room it has is the room on that side. The behaviour layer reports that room as `--available-height`, but the menu did not use it.
- **Error class:** A popup sized against the whole viewport rather than against the room the positioner gives it on its side.
- **Guard:** `packages/ui/src/v2/menu-height.browser.test.ts` opens 60 entries at 1024×700 and 1440×700, once under a button in the head and once behind the lowest row, in Chromium and WebKit. It checks that the menu stays inside the screen with its 8 px margin, that it scrolls inside, and that `ArrowDown`, `End` and `Home` bring the entry they reach into view.
