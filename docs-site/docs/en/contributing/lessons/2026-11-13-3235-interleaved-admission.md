### Keep admission authority local across asynchronous cache reads

- **What happened:** Two documents sharing one room could reject an otherwise valid edit with “Document admission head is unavailable”. An interleaved replay could also skip uncovered history.
- **Root cause:** Admission validated a shared mutable tail after yielding, while replay iterators consulted mutable cache bounds after yielding cached entries. Another document could replace either hint before the first operation resumed.
- **Error class:** Cross-document interference across asynchronous suspension points.
- **Guard:** Document admission tests hold one head read after its yield, complete a second document and then resume the first. Replay-cache tests replace the document and evict covered entries between yields. Each operation captures its own head, bounds and entry list; shared caches supply hints only.
