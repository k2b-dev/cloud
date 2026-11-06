### NumberInput dropped trailing fraction zeros

- **What happened:** A currency value of `321.4` with `step={0.01}` displayed as `321,4` instead of `321,40` in German.
- **Root cause:** The display used `String(value)`, which discards trailing zeros, and resynchronization compared parsed numbers rather than formatted text.
- **Error class:** Numeric display precision diverges from the input precision contract.
- **Guard:** `packages/ui/test/intl-locale.behavior.test.tsx` checks that blur shows `321,40`, typing preserves the caret, display changes emit no extra value change, and precision and locale changes resynchronize. `packages/ui/src/intl/intl.render.test.ts` checks padded server output.
