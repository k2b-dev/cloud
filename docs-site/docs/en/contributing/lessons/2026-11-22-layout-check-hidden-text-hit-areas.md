### Hidden label text made touch hit areas count as a spill

- **What happened:** In WebKit with a coarse pointer, `layoutProblems`
  reported Mail's head actions at 390 px as "spills 8 px out of its box".
  Nothing visible stood out. The extra width came only from touch hit areas.
- **Root cause:** `onlyHitAreas` measured the box's whole content as one text
  range. The primary action keeps its label for screen readers in a 1 px
  clipped box, and that text runs on past the head in the layout. The range
  reached past the box, so the check treated the hit areas as real content.
- **Error class:** A layout check that measures content a person cannot see,
  so a visually hidden label turns an allowed extension into a finding.
- **Guard:** `onlyHitAreas` measures each run of text and skips text and
  elements in visually hidden boxes. A clipped or overflow-hidden box of at
  most 1 px counts as hidden. `layout-problems.browser.test.ts` checks with
  touch at 390 px that a head with hit areas and a hidden label passes, and
  that the same label drawn visibly still spills.
