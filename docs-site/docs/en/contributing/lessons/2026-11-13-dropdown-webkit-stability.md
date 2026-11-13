### A popup anchor changes geometry during its press animation

- **What happened:** WebKit intermittently moved a dropdown search field by 1/64 px after keyboard navigation scrolled its entries (#3289). Holding the mouse down until the press animation finished reproduced a 1 px horizontal shift.
- **Root cause:** Dropdown placement read the button's scaled viewport box during its release animation. The menu kept that intermediate position after the button settled. Scrolling its entries triggered placement again with the unscaled box and moved the entire popup.
- **Error class:** A floating surface uses transient animation geometry as its lasting anchor.
- **Guard:** `packages/ui/src/actions/dropdown-search.browser.test.ts` holds the pointer until the press animation settles before releasing it, then requires exactly equal search-field and trigger boxes while keyboard navigation scrolls the list. `packages/ui/src/actions/actions.render.test.tsx` requires the shared press-scale rule to exclude popup triggers and retain flat feedback. Run stylesheet-reading tests in both `.test.ts` and `.test.tsx`; CSS contracts also live outside `styles/`.
