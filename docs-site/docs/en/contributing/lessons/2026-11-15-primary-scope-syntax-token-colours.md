### Syntax token colours were flagged as primary colours

- **What happened:** The primary scope audit reported `SPAN.cd-s` and `SPAN.cd-a` in a code view demo as blue that does not follow the AI scope (Sync 49, #3393).
- **Root cause:** The dark syntax colours `--k2b-code-string` (#bfdbfe) and `--k2b-code-number` (#93c5fd) have the same values as `--k2b-accent-200` and `--k2b-accent-300`. The audit only sees colour values, so content colours that happen to match the accent ramp looked like unscoped primary paint.
- **Error class:** A colour audit treats content colours (syntax, tags, status) as primary colour because their values coincide with the accent palette.
- **Guard:** The audit exempts only the text colours (`color`, `caret-color`, `text-decoration-color`) of syntax token spans (`span.cd-*`); focus rings, selection, buttons, line marks and borders in the same view stay audited. A self-test in `primary-scope.browser.test.ts` proves an accent-valued token is exempt while a blue focus ring beside it is still reported.
