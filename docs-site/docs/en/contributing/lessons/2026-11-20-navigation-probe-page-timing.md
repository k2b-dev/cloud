### A WebKit navigation stall could not tell a slow page from a lost event

- **What happened:** The first `goto` of `keys: the private key shows once, and closing it unsaved asks first` timed out after 8 s in one WebKit CI job (#3836). The document committed. The diagnosis reported no DOMContentLoaded and no load. The main-thread probe needed 1,995 ms and found `readyState complete`.
- **Root cause:** Suspected: the page's main thread was busy for about 10 s on the runner. The diagnosis cannot confirm it, because a page that fires its events late and a test that never receives them look the same. The Ed25519 refusal of #2286 and a slow font alone do not match. The test failed before any click. A font held back for 9.5 s in local WebKit gives "DOMContentLoaded: fired" and a probe answer in 7 ms. None of 201 failed WebKit jobs since 18.11. had a navigation timeout.
- **Error class:** Navigation stall without evidence.
- **Guard:** The main-thread probe in `packages/ui/test/browser.ts` adds the document's own navigation timing: response end, DOMContentLoaded, load and age. `packages/ui/test/browser.browser.test.ts` checks the line for a committed navigation whose load never fires.
