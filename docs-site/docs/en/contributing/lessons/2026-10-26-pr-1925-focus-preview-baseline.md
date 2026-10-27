### Close focus previews before measuring an overlay baseline

- **What happened:** #1972: the focus-return browser test captured an automatically opened sidebar preview as its closed baseline, then compared its visible boxes with the closed result.
- **Root cause:** Keyboard focus schedules the preview after 250 ms, so tabbing to the trigger does not guarantee a closed card.
- **Error class:** A browser test assumes an asynchronous interaction has not changed its initial state.
- **Guard:** Test: `packages/ui/src/internal/focus-return.browser.test.ts`. The keyboard-open cases press Escape after reaching the trigger, canceling pending or open previews, and assert a closed baseline before checking the returned focus ring and unchanged layout.
