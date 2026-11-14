### A field edge showed two thin lines and a stepper fill stopped short of it

- **What happened:** At fractional zoom, a focused NumberInput showed its blue edge as two thin lines with a lighter seam between them. A hovered stepper's fill left thin strips at the rounded corner and along the edge, and the divider beside it turned a light blue extra line on focus.
- **Root cause:** Every field drew its 2 px edge from two sources: a 1 px border and a 1 px inset shadow in the same colour. The browser rounds the border to device pixels but paints the shadow at its fractional position, so the two drift apart. The stepper is a child, so its fill painted over the inset; it repeated the inner pixel with straight shadows of its own, which do not follow the corner.
- **Error class:** Two drawing sources for one visual edge.
- **Guard:** `packages/ui/src/styles/control-edge.browser.test.ts` requires one 2 px border with no box-shadow or outline beside it in every state. At 1.5x it scans a pixel column through each field's top edge for a seam, and it checks that steppers start right inside the border, are clipped to its corner, and part from the value with one line in `--k2b-edge`.
