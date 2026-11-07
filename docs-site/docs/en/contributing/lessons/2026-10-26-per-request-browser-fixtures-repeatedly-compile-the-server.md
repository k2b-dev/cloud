### Per-request browser fixtures repeatedly compile the server

- **What happened:** Cold Babel and workspace imports consume the snapshot deadline before the page executes.
- **Root cause:** The fixture compiled Babel and workspace imports on each request within the snapshot deadline.
- **Error class:** Per-request browser fixtures repeatedly compile the server
- **Guard:** Test: Pulse `PulseWorkspace.browser.test.ts` renders the real page from a bundle prepared once during setup. Each render still runs in a fresh process with the unchanged 15-second deadline; only app-owned page data and platform SSR preloads are substituted.
