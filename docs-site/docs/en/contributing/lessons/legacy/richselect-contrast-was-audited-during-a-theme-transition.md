### RichSelect contrast was audited during a theme transition

- **What happened:** The desktop and tablet dark-mode accessibility cases reported both RichSelect placeholders below 4.5:1 while the light and phone cases passed.
- **Root cause:** The fixture switched from light to dark immediately before running axe. The empty-value hint already used `#bdbdc6`, while the field background was still transitioning from `#f4f4f5`: axe measured 1.69:1. After the same transition finished, the background was `#20242a` and the audit passed. The dark palette itself did not need changing.
- **Error class:** State sampled before it settled.
- **Guard:** `rich-select.browser.test.ts` calls `settled()` before each accessibility audit. A regression case starts a deliberately extended background transition, verifies it is running, then checks the completed state through the same audit helper. Axe failures retain their targets and color/contrast explanation.
