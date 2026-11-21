### A 44 px touch target measured 43.9999 px in WebKit

- **What happened:** The WebKit browser test of the date field on a phone
  failed now and then (#3917). The day button in the calendar sheet measured
  43.99993896484375 px, and the test required at least 44 px. Other runs of
  the same shard passed.
- **Root cause:** Suspected: the test read the button's box right after the
  sheet appeared, while its opening transform could still scale it, and
  WebKit reads boxes back in 1/64 px units. The size came from `2.75rem`.
- **Error class:** A layout test compares a measured float exactly with a
  whole-pixel rule, so sub-pixel rounding of the engine fails it, not the
  rule.
- **Guard:** Touch-target tests compare with `touchTargetMin` from
  `packages/ui/test/browser.ts` (44 px less 0.01 px) and measure after
  `settled(page)`. The sheet sets its targets in px (`min-block-size: 44px`).
