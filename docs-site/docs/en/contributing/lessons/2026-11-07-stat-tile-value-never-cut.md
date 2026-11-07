### Key figure tiles cut their figures to "48…" on phones

- **What happened:** On a 390 px phone the dashboard key figure tiles (`StatGrid` in the default `md` size) showed "48…", "1…" and "€2…" instead of their figures.
- **Root cause:** `.k2b-stat-cell__value` ended overflowing text in an ellipsis, and only the `lg` size moved the change badge under the figure and shrank it in narrow tiles; an `md` tile kept figure and badge side by side at a fixed size in a 150 px tile.
- **Error class:** A primary value in a responsive tile truncated with `text-overflow: ellipsis` instead of fitting itself, and responsive rules written for one size variant only.
- **Guard:** `packages/ui/src/surfaces/stat-tiles.browser.test.ts` ("a figure always fits its tile") renders every size with long figures at 300, 366, 296 and 1384 px frames and fails when a value overflows its tile or ends in an ellipsis.
