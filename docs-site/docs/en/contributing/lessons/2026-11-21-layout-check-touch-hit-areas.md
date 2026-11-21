### The layout self-check reported touch hit areas as spills

- **What happened:** With touch at 390 px, `layoutProblems` reported icon
  buttons, checkboxes, and reaction bars as "spills 10–15 px out of its box".
  Apps skipped those boxes with `data-layout-check="skip"`, which also hid
  real defects in them.
- **Root cause:** On a coarse pointer, small controls reach 44 px with an
  empty, transparent, absolutely positioned pseudo-element. It is part of the
  scrollable overflow, so `scrollWidth` grew past `clientWidth`, and the check
  could not tell a hit area from content.
- **Error class:** A self-check that measures overflow without telling
  intended invisible extensions from visible content, so callers paper over
  it with blanket exceptions.
- **Guard:** `layoutProblems` ignores overflow that only empty, invisible,
  positioned pseudo-elements cause. `layout-problems.browser.test.ts` checks
  with touch at 390 px that an icon button and an app-built hit area pass, and
  that a drawn badge pseudo-element and real content beside a hit area still
  spill.
