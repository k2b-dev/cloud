### Most Cloud pages had no framing policy

- **What happened:** Only a few routes, such as mobile pages and the gateway's maintenance page, said who may display them in a frame. The sign-in page and ordinary application pages left this to the browser, so pages of other sites could display them in a frame.
- **Root cause:** Each route chose its framing policy on its own, and no shared layer set a default. The gateway, which returns every answer of a Cloud installation, passed pages through without one.
- **Error class:** A protection that every page needs depends on each route remembering to add it.
- **Guard:** The gateway gives every HTML answer without a framing policy of its own `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`. `packages/gateway/src/framing.test.ts` checks the answers of every gateway branch, and `framing.browser.test.ts` checks in a real browser that same-origin frames such as the side panel still load and other origins cannot frame a page.
