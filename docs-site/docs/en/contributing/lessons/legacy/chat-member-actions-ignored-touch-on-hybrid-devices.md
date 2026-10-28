### Chat member actions ignored touch on hybrid devices

- **What happened:** The remove action stayed hidden during touch input on a laptop, while a tablet with a mouse kept it visible ([#1287](https://github.com/k2b-dev/cloud/issues/1287)).
- **Root cause:** The action used the primary-pointer hover query instead of the shared current-input attributes and any-hover fallback.
- **Error class:** Primary pointer substituted for current input mode.
- **Guard:** `ChatWorkspace.browser.test.ts` checks touch and trackpad modes at desktop, tablet and phone widths in both themes, unchanged action and row boxes, keyboard activation, cancellation and focus return.
