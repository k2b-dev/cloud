### A logger factory mock misses an already imported reader

- **What happened:** The cancellation test failed when another test imported the activity reader first, even though its warning appeared in the log.
- **Root cause:** The reader cached its logger before the test replaced the logger factory. The replacement could not intercept that existing instance.
- **Error class:** Module mocks depend on test-file import order.
- **Guard:** The cancellation test spies on the real logger's console warning and asserts it before settling the original query. Running `service/activity-reader-service.test.ts` followed by `data/activity-reader.test.ts` in one Bun process reproduces the failure before this fix and verifies the cached-module path afterward.
