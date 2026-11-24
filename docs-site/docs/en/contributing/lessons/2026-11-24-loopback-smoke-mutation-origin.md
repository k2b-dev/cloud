### A loopback smoke sends its mutations from the wrong origin

- **What happened:** From 5 November, the nightly Grids and Chat browser smokes failed with `query-result first-page request returned 403` and `new chat returned 403`. The browser reached the stack at `http://127.0.0.1:3000`, while its public origin was `https://127.0.0.1:3000`.
- **Root cause:** Since the session origin check of 4 November, Cloud refuses a cookie-authenticated mutation whose Origin is not the public origin. The smokes relayed only the live socket with the public origin. The page's own POST requests kept the loopback origin, because Chromium ignores an Origin that a route sets, and the Grids smoke's cookie requests through Playwright's request context sent no Origin at all.
- **Error class:** A loopback smoke sends the wrong session origin.
- **Guard:** `packages/grids/scripts/browser-smoke-live.browser.test.ts` shows that a loopback page sends its own origin, and that `sendMutationsFromPublicOrigin` delivers the page's mutations with the public origin, session and body while reads pass unchanged. The Grids and Chat smokes send their mutations that way.
