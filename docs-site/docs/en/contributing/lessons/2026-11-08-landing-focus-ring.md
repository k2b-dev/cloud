### A focused landing point drew the browser's ring around the page card

- **What happened:** On a phone, the Assistant page opened from the side panel showed a near-black, rounded edge along the top of its content card. It looked like a border, and it was already on main.
- **Root cause:** After a page swap or when a panel closes, code focuses the page's `main`, its swapped root, or its first heading with `tabindex="-1"` so screen readers start there. Chromium counted that focus as keyboard focus and drew its default `outline: auto` ring, which is near black, around the whole rounded card. The audit compared images before and after, so a defect that was present in both never showed up.
- **Error class:** A non-interactive focus target that falls back to the browser's default focus ring.
- **Guard:** `@k2b/ui` gives landing points (`main`, `[data-scroll-page]`, headings with `tabindex="-1"`) no ring, and roving items keep theirs. `focus-rings.browser.test.ts` checks both. `ChatPanel.browser.test.ts` checks at 390 and 1440 px that the main card has no ink edge and no ring after focus lands on it. Audits also look for absolute defects, not only differences.
