### Flat lines and fills stopped short of their area, and no check saw it

- **What happened:** The flat UI passed its QA, and the maintainer still found
  four defects in the screenshots: lines and fills that end before the column
  edge, double lines a few pixels apart, a resize grip off its line, and font
  sizes outside the mockup's four sizes. The layout self-check reported none of
  them.
- **Root cause:** `layoutProblems` only knew error classes: overlap, spill,
  cut, touching double lines, and scrollbar breaks. Nothing compared the page
  with the values of the approved mockup: where a line ends, how far apart two
  lines lie, where a grip sits, and which type styles exist.
- **Error class:** Flat lines and fills stop short of their area; QA checked
  error classes instead of mockup values.
- **Guard:** `layoutProblems` has four flat kinds behind the `flat` option:
  `short-edge`, `near-double`, `grip-off-center`, and `type-role`. The type
  roles live once, in the `--k2b-type-roles` token of `@k2b/ui`. The kinds see
  lines drawn as box-shadows and pseudo-elements, which the flat columns use;
  the old double check reads only `border-*`. They found the sidebar, detail,
  and pane grips half a pixel off their line and under it, now fixed. Grips
  and lines on half pixels blur, so `grip-off-center` also reports fractional
  edges, and a standalone `ResizeSeparator` is now its 1 px line in the flow
  with its hit area and grip over the neighbours.
  `layout-problems-flat.browser.test.ts` finds each defect and passes its clean
  form in Chromium and WebKit. `flat-shell-findings.browser.test.ts` records
  what today's shell shows, so each rebuilt building block removes its lines
  from that record. Apps turn the kinds on as their screens are rebuilt.
