### A collapsible card heading looked selected, and blue text actions turned black on hover

- **What happened:** A collapsible `Section` card filled its heading with a light blue band on hover and while open. The band reached 0.75rem above the title but only 0.375rem below it, so the open card looked selected and its gaps looked uneven. A `text` button in section or summary actions turned black on hover, and a `link` button gained an underline but kept its color.
- **Root cause:** The disclosure button reached over the card's padding with negative margins and painted `--k2b-hover` on that box. Only `ghost` had a hover rule in heading actions, so the generic `text` hover rule set the body ink. The `link` hover reused `--k2b-action`.
- **Error class:** A hover or hit-area rule paints a larger box than the element people see, or a contextual color override lacks its hover state and the generic rule wins.
- **Guard:** `packages/ui/src/surfaces/section.browser.test.ts` checks that a collapsible card heading has no fill at rest, on hover, or with focus, that its gaps match a fixed card, and that every blue text action darkens to `--k2b-action-hover` without an underline.
