### One hung browser test failed the rest of its file

- **What happened:** One timeout in the bare dialog suite caused 20 later browser tests to fail ([#1254](https://github.com/k2b-dev/cloud/issues/1254)).
- **Root cause:** Bun's timeout cleanup sends SIGTERM to every subprocess the test process started, including the shared browser. A browser still shutting down can report itself connected while page creation fails with a protocol error.
- **Error class:** Shared subprocess lost after timeout.
- **Guard:** `packages/ui/test/browser.browser.test.ts` checks that only the hung test fails and three later tests pass. For local launches, it also checks that Bun killed the browser. The launcher replaces a disconnected browser or retries a failed page or context creation once. Pages and contexts must be opened per test.
