### A frame URL did not identify a pending script request

- **What happened:** The delayed PanelRuntime test sometimes observed an already ready panel in WebKit ([#1833](https://github.com/k2b-dev/cloud/issues/1833)).
- **Root cause:** The route selected a script using its frame’s current URL, which can still be the initial URL while the new document loads.
- **Error class:** A test gate depends on navigation timing instead of the resource it holds.
- **Guard:** Test: `ChatPanel.browser.test.ts` marks runtime script URLs by provider; the test holds the Assistant URL unconditionally and asserts interception before checking that the panel is not ready.
