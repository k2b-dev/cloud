### Avoid measuring scroll overflow after every live row mutation

- **What happened:** repeated forced layout. Updating many unread badges made the shared scroll-fade observer measure each intermediate layout, delaying Chat's batch-read response and interaction completion.
- **Root cause:** The shared scroll-fade observer measured each intermediate row mutation instead of coalescing mutations into one frame.
- **Error class:** repeated forced layout
- **Guard:** `scroll-fade.behavior.test.tsx` checks that separate row mutations share one frame measurement, scrolling still updates immediately, and disposal cancels pending work. Resize observations remain synchronous before paint. Chat's 51-conversation browser case checks both read batches with the original deadlines. The DOM test prepares the component imports before individual test deadlines, so a cold transform cannot time out and leave asynchronous cleanup running inside the next test.
