### A status row cut a label to a letter

- **What happened:** In Spaces at 1100 px with Detail open, the status row's disturbance showed its sign and "A…" for "Abgleich pausiert". The label kept 15 px, so its ellipsis left one letter, which tells nobody anything (flat QA, rule 15).
- **Root cause:** The label of `StatusRow`'s state shrank to any width (`min-width: 0`) as long as its ellipsis applied. Nothing stated a smallest useful width, so the row handed the label whatever room was left.
- **Error class:** Text that shortens with an ellipsis has no minimum, so it shrinks to a letter or to "…" alone instead of giving way whole.
- **Guard:** `packages/ui/src/layout/status-row.browser.test.ts` checks at 390, 441 (1100 px with Detail), 520, and 760 px that the label shows at least about a word (4.5 em, or all of it) or is hidden whole while the hint keeps the words. The label has a minimum of `min(4.5em, max-content)` and a container query hides it, visually only, where the sign, a word, and the time do not fit.
