### A host tone reached only one half of a split button

- **What happened:** Mail's Send button showed the app colour on its main half and the default blue on its menu half (#3208).
- **Root cause:** `SplitButton` put the host `class` on the main segment only, and Mail coloured the menu half with a sibling selector. A tooltip on the main action renders a span between the two segments, so the selector never matched.
- **Error class:** A compound control lets a host style one part, and the host reaches the other part through DOM structure it does not own.
- **Guard:** `SplitButton` applies `class` to the whole control, and `packages/ui/src/actions/split-button-fill.browser.test.ts` asserts equal fills for both segments under a host tone with a tooltip.
