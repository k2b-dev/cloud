### A Lightbox test read the name before WebKit had stepped

- **What happened:** `approval-scenes.browser.test.ts` pressed → in the Lightbox and read the name of the shown block at once. In `webkit (10)` it read "PayPal-Buchungen im November", the block before "PayPal-Umsatz", twice on `feat/code`.
- **Root cause:** The Lightbox sets the next name within the key's own event. In Chromium `keyboard.press` returns after the page handled the key; in WebKit the key reaches the page after `press` returns, so a read straight after it can still see the old state.
- **Error class:** A browser test asserted state right after an input instead of waiting for the state the input shows.
- **Guard:** Convention for browser tests that step, open or switch something with a key or click: wait for the shown result (a locator with `hasText`, or the focus where the keys go) before reading it; never a fixed pause. The test now waits for each name and for the focus on the stage.
