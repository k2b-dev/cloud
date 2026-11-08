### Keep geometry checks independent of unrelated hydration

- **What happened:** A WebKit merge-group run timed out after 5003ms while checking two distribution cards on the chart overview. Its desktop case took 4.8 seconds against the same 5-second budget.
- **Root cause:** The test loaded every live overview card, hydrated its islands and waited for network idle even though the assertions only measured server-rendered SVG geometry.
- **Error class:** A focused layout guard depends on unrelated client startup work.
- **Guard:** Geometry-only overview checks load the real server document with its script tags removed, wait for `load`, then settle fonts and layout before reading bounds. The guard requires no script elements and verifies that both target cards and Pareto axis text exist, preventing vacuous geometry passes. The existing overview test still checks full hydration parity and console errors. All clipping and overlap assertions and the default timeout remain unchanged. This is a test-local convention; a repository-wide static rule would impose it on unrelated interaction tests.

Playwright evaluation stays enabled so the shared `settled()` helper can await fonts and animation frames. Disabling page JavaScript entirely also prevents that helper from completing in Chromium.
