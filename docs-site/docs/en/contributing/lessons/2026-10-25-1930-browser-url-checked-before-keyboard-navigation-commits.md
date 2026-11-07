### Browser URL checked before keyboard navigation commits

- **What happened:** A link activation returns before the browser reports its new fragment, making a correct interaction fail intermittently.
- **Root cause:** Browser URL checked before keyboard navigation commits.
- **Error class:** Browser URL checked before keyboard navigation commits.
- **Guard:** Test: UI `data-table-focus.browser.test.ts` waits for the expected URL after Enter before checking the destination and row handler count.
