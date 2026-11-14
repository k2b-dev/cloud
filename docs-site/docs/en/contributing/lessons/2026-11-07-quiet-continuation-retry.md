### Keep quiet continuation actions stable through retry

- **What happened:** Files continuation actions looked heavy, and retrying some lists changed their label or removed the error above the button before the request finished.
- **Root cause:** Applications selected retry labels from errors that were cleared at request start; the provider folder also hid its retained error while loading. The inspector query clears its error immediately when refreshed.
- **Error class:** Pending retry presentation derived from transient query error state.
- **Guard:** `history.behavior.test.tsx`, `browser-selection.behavior.test.tsx`, `choose-files.behavior.test.tsx` and `Approvals.behavior.test.tsx` retain the retry label and error through a controlled pending response. `Pagination.browser.test.ts` checks retry dimensions and position. The shared `button-loading.browser.test.ts` checks all variants and sizes plus action colour, regular weight, hover and keyboard focus in both themes. Its expanded suite has a conservative 20-second WebKit planning estimate; the local Chromium run took 15.28 seconds. The shard budget remains unchanged.
