### Caught chart errors must reach the host without browser error redispatch

- **What happened:** A rare chart showed its formatter error without a retry button, but the WebKit test timed out waiting for that message at the host.
- **Root cause:** The caught drawing error was handed to native `reportError` in the opaque app frame; its diagnostic did not reach the host with the original message. The frame already owned a bounded host error channel but only used it from native event handlers.
- **Error class:** A caught application error depends on browser error redispatch to reach its diagnostic consumer.
- **Guard:** Assistant `lazy-charts.browser.test.ts` requires the concrete formatter message once at the host, a visible error without retry, and no network requests; Chromium and WebKit run the same assertion and timeout.
