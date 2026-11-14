### A live thread summary replaced a pressed link

- **What happened:** Opening another thread after Back intermittently left WebKit at the chat address ([#2411](https://github.com/k2b-dev/cloud/issues/2411)). A controlled live refresh between pointer down and pointer up reproduced the same navigation timeout.
- **Root cause:** `ThreadRows` keyed Solid's `For` by thread objects. Read updates and live summary responses replace those objects, so the refresh detached the pressed anchor and inserted another for the same thread. Releasing the pointer could no longer activate that link. The rows now use stable thread IDs; their labels and unread marks still read the current summaries.
- **Error class:** Keying interactive list items by replaceable snapshots instead of domain identity.
- **Guard:** `ChatThreads.browser.test.ts` opens a thread, goes Back, holds the pointer on another thread, and applies a live summary refresh before releasing it. It requires the same anchor, the refreshed label, and successful navigation. The existing Back-and-open flow remains unchanged.
