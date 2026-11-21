### The layout self-check missed a panel that scrolled sideways

- **What happened:** In the flat-design QA, a detail panel body scrolled
  40 px sideways. `layoutProblems` passed the page, because it only reported a
  page that scrolls sideways, not a scroll container inside it.
- **Root cause:** The check treated every box with `overflow-x: auto` or
  `scroll` as a place where a person can reach wide content, so it skipped
  them. A box with only `overflow-y: auto` computes `overflow-x` to auto as
  well, so too-wide content in a vertical scroll area went unseen. Headless
  Chromium also hides scrollbars, so a column that a classic scrollbar makes
  too narrow never overflowed in tests.
- **Error class:** A self-check that exempts a whole mechanism (scroll
  containers) instead of the intended uses of it.
- **Guard:** `layoutProblems` reports every sideways scroller as `scroll`
  unless it carries `data-layout-check="scroll-x"` or is a toolbar below
  768 px. `layout-problems.browser.test.ts` runs with classic scrollbars and
  checks a panel body, a toolbar on a wide screen, and a column that only a
  classic scrollbar makes too narrow.
