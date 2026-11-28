### v2 parts wrote data colours into styles unchecked

- **What happened:** v2 parts that take a data colour (Avatar, Chip, Row, Cells.Cell, Section and Ticks) handed it to `custom()`, which wrote it into the style attribute exactly as it came. A colour comes from data, such as the colour of a base or a tag. A value with a `;` would have added declarations to the style that the server sends.
- **Root cause:** `custom()` trusted its callers, and no layer between the data and the style checked the value.
- **Error class:** A value from data goes into a style without a check in the layer that writes it.
- **Guard:** `custom()` in `packages/ui/src/v2/marks.tsx` writes `--k2-c` only when `safeColor` in `packages/ui/src/v2/colors.ts` accepts it as a hex colour, an `oklch()` of plain numbers or a custom property of the page, and writes any other property only when `safeValue` finds no sign that could end its declaration. Data colours reach a style only through `custom()`. `packages/ui/src/v2/colour-props.test.ts` checks both functions and renders five of these parts on the server with values that are no colour, and expects no declaration of their own.
