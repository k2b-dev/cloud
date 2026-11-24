### A v2 list test passed in WebKit with the fix switched off

- **What happened:** The browser test for a v2 `List` that keeps the focused entry in place when new entries arrive on top passed in WebKit even after the list code that holds the place was disabled. The test was written to cover Safari, but it proved nothing there.
- **Root cause:** The WebKit build of Playwright anchors scrolling by itself (`overflow-anchor` is supported there), while shipping Safari does not. The browser held the place, not the list.
- **Error class:** A browser test for a fix that a browser feature can also provide passes without the fix, because the test engine has the feature and the target browser does not.
- **Guard:** The list test switches scroll anchoring off (`.k2-scroll { overflow-anchor: none }`), so only the list can hold the place. Each v2 fix in this change was checked red without its fix and green with it, in Chromium and WebKit.
