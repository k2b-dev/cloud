### A browser assertion races native link navigation

- **What happened:** Completing a keyboard event does not mean the browser has applied the link’s destination.
- **Root cause:** A browser assertion races native link navigation.
- **Error class:** A browser assertion races native link navigation
- **Guard:** Test: UI `data-table-focus.browser.test.ts` waits for the expected URL fragment before checking navigation and row-action counts ([#1743](https://github.com/k2b-dev/cloud/issues/1743)).
