### Clearing a text field removes the focused action

- **What happened:** The clear button disappears with the value and leaves keyboard users outside the field.
- **Root cause:** Clearing a text field removes the focused action.
- **Error class:** Clearing a text field removes the focused action.
- **Guard:** Tests: UI `text-input-clear.browser.test.ts` checks focus and typing after clearing with default callbacks and custom `onClear`; Files `History.browser.test.ts` checks the real history search in English and German.
