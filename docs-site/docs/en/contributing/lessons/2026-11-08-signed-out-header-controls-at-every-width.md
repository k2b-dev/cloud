### Keep the signed-out header's controls at every width

- **What happened:** Signed-out pages showed help and the app grid in the header below 1024 px and dropped both from 1024 px on, while the documentation said these pages have no app grid at all ([#2921](https://github.com/k2b-dev/cloud/issues/2921)).
- **Root cause:** The header's controls sat in a wrapper with `lg:hidden`, a rule written for the signed-in phone header, where the rail takes over from `md`. Signed-out pages have no rail, so the controls had no other place from `lg`.
- **Error class:** A breakpoint rule written for one shell mode also hides content in another mode that has no replacement for it.
- **Guard:** `packages/cloud/src/ssr/LayoutHeader.browser.test.ts` renders the signed-out header at 360, 390, 900 and 1280 px and expects the same visible controls inside the card at each width.
