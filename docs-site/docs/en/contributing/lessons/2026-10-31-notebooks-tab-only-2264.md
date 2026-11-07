### Device storage failure must leave an explicit way to keep writing

- **What happened:** A failed device session left a writable Notebook note read-only with only retry. Browser fixtures missing the document route also disabled editing and broke comment interactions.
- **Root cause:** Editor readiness required successful device storage and a document response. The comments and preview harnesses did not serve that new response; the editor had no explicit memory-only choice.
- **Error class:** An optional persistence dependency blocks the primary task; editor fixtures drift from their transport contract.
- **Guard:** `offline.browser.test.ts` rejects missing IndexedDB, storage access, quota, server and network failures, then checks explicit tab-only typing, a persistent loss notice, unload protection, Undo/Redo, failed retries and merging with changed committed server text without lost words. `sync-ended.behavior.test.tsx` guards overlapping session opens, typing while a server retry waits, and copying the exact visible input when merging fails. Access failures remain read-only. The comments and preview browser tests serve committed Yjs state shared with their sockets.
