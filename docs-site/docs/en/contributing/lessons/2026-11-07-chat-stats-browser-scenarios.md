### Give each browser scenario its own test lifecycle

- **What happened:** The new Chat change-badge fixture timed out in WebKit's five-second test budget, closing the active page during `evaluate`.
- **Root cause:** Four independent locale/viewport scenarios each created, navigated and closed a fresh browser context inside one test. Their combined setup, loading measurements and teardown shared a single deadline.
- **Error class:** Independent browser scenarios were hidden in one test lifecycle.
- **Guard:** The Chat browser fixture registers one test per locale/viewport. All badge, number-format and exact loading-geometry assertions remain, with the unchanged default timeout for each test.
