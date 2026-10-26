### An SSR browser fixture leaves an asset request external

- **What happened:** The generated shell requests its branding image, but the fixture intercepts only app and API routes; navigation can wait on DNS or the unavailable host instead of reaching `load`.
- **Root cause:** The fixture intercepted app and API routes but left the branding image request external.
- **Error class:** An SSR browser fixture leaves an asset request external
- **Guard:** Test: Pulse `PulseWorkspace.browser.test.ts` supplies a local branding SVG, rejects unexpected requests, checks decoded logo images, and retains the normal navigation load wait and SSR height checks.
