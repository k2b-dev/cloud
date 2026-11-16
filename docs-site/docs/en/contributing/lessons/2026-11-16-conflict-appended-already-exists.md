### Conflicts read "… already exists" after a whole sentence

- **What happened:** A 409 from Core read "Task state changed; read it and retry already exists", and Pulse answered "Pulse base is being deleted already exists" (#1326).
- **Root cause:** `err.conflict(what)` from `@k2b/stdlib` appended " already exists" to its argument, while most calls in Cloud passed a whole sentence. About 40 calls passed only a subject, such as "API key" or "Tag with that name", and relied on the appended words.
- **Error class:** A factory that completes a message the caller already wrote.
- **Guard:** `@k2b/stdlib` 0.33.0 takes the sentence as given and pins that in its own test. In Cloud every subject call now writes its sentence out: "… already exists" for a duplicate, "… changed; reload it and retry" for a stale revision. The rule `conflict-sentences` reports an `err.conflict` literal without a verb or a request; on the code before the fix it finds all 41 subject calls. Its first version counted words and missed every subject of two or more words, and it parsed `.ts` files as TSX, which broke on generic arrow functions and hid the rest of a file.
