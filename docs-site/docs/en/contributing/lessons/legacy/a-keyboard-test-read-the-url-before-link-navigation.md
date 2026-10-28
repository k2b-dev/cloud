### A keyboard test read the URL before link navigation

- **What happened:** The DataTable focus test saw its fixture hash after Enter instead of the cell link's destination ([#1749](https://github.com/k2b-dev/cloud/issues/1749)).
- **Root cause:** Awaiting keyboard dispatch did not wait for the browser's link navigation.
- **Error class:** Reading asynchronous state before the completion condition.
- **Guard:** `data-table-focus.browser.test.ts` waits for the destination URL, then retains its exact URL and callback-count assertions without increasing timeouts.
