### Signed-in shell fell between its two modes

- **What happened:** While the card moved from 1536 px to 1024 px, review found that a width between 1023 and 1024 CSS pixels, such as a 1126 px window at 110 % zoom, matched neither the flush mode nor the card. The rail then moved 8 px to the right and the card took the base spacing. The phone mode had the same gap at 767 and 768 px ([#1255](https://github.com/k2b-dev/cloud/issues/1255)).
- **Root cause:** The flush mode ended at `max-width: 1023px` and the card started at `min-width: 1024px`. Playwright snaps viewports and frames to whole pixels, so no browser test reached the gap.
- **Error class:** Breakpoint gap.
- **Guard:** Each shell query in `global.css` states only `min-width`, negated with `not all and` for the range below. `shell-modes.test.ts` pins these queries.
