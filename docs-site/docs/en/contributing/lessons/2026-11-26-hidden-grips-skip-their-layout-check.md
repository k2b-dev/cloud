### Grips hidden at rest would have switched off their own layout check

- **What happened:** When the v2 column grips started to rest at `opacity: 0` (shown only on hover, focus and drag), `measureV2Layout` measured no grip at all, and 22 primitive layout tests at 1440 px failed on `layout.grips.length > 0`.
- **Root cause:** `measureV2Layout` measures only visible elements (`checkVisibility` with `opacityProperty`), so a grip that is hidden until it is wanted silently left the pill-on-its-line rule.
- **Error class:** A measurement that skips hidden elements loses its rule without a failure when a component starts to hide that element at rest.
- **Guard:** `measureV2Layout` shows every grip while it measures and hides them again; `primitives.browser.test.ts` requires at least one measured grip at 1440 px, and `grips.browser.test.ts` checks the rest, hover, focus, drag and touch states.
