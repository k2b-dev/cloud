### A loopback smoke sends the wrong session origin

- **What happened:** A smoke opens its page on loopback while Cloud expects the public origin; the live socket is refused with `forbidden_origin` and `1008`.
- **Root cause:** The browser opened on loopback while the session expected the public origin.
- **Error class:** A loopback smoke sends the wrong session origin
- **Guard:** Tests: Grids `browser-smoke-live.browser.test.ts` observes the loopback browser's origin, tests the public-origin relay, and keeps other sockets untouched; `browser-smoke-live.test.ts` executes Nightly's smoke loop and checks the Grids and Chat arguments. The browser guard also checks that diagnostics omit payloads and arbitrary close reasons.
