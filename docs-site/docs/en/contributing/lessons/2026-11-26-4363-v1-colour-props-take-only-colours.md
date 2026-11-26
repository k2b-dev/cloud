### v1 parts wrote colour props into styles unchecked

- **What happened:** About 20 v1 places in `@k2b/ui` wrote a colour prop into a style exactly as they got it: the selects, dropdown, filter chip and colour inputs; navigation, sidebar switcher and detail presence; the calendar's events in every view; and the notice row, dashboard section, chat decision, chat activity and floating window. Callers pass hex colours, colour names, `rgb()`, custom properties and `color-mix()`. A value with a `;` would have added declarations to the style.
- **Root cause:** The parts trusted their callers. A check lived in some apps' contracts, not in the library that writes the style.
- **Error class:** A value from data goes into a style without a check in the layer that writes it.
- **Guard:** `cssColor` in `packages/ui/src/internal/color.ts` accepts:
  - a hex colour, a colour name, or a custom property;
  - a value built from a fixed list of colour functions (`rgb`, `oklch`, `color-mix`, `var` and a few more), with only letters, digits, `# . , % / -`, spaces and balanced parentheses.

  Every place above passes its colour through it, and the calendar decides its own colour from the checked value. A choice shows its dot only when the colour passes, and its icon otherwise. `packages/ui/src/internal/colour-values.render.test.tsx` renders twelve of these parts on the server with values that are no colour and expects no declaration of their own. It also pins the `color-mix()` tint that the code page tree passes. The floating window draws only in the browser, so the test has no server markup for it. v2 parts check their colours in `custom()`.
