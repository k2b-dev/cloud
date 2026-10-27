### settled() failed on the view transition of a navigation the test made

- **What happened:** Chat browser tests (phone layout, read state, info reopening) failed in merge groups with "settled: the page kept animating" naming `-ua-view-transition-*` animations on `html`. Each failure removed a whole merge group from the queue.
- **Root cause:** After a navigation commits, Chromium and WebKit can start the document view transition a frame later, while `settled()` is already waiting on other animations. `settled()` then saw new finite animations and treated the page as one that keeps animating.
- **Error class:** A settle helper treats the browser's own transition for a navigation the test triggered as unstable page motion.
- **Guard:** `settled()` also awaits user-agent animations on the document element, a bounded number of rounds; any other animation that starts meanwhile still fails. A browser test starts a view transition while `settled()` waits and requires the transition to be finished when it returns.
