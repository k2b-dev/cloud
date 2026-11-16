### Conflicts read "… already exists" after a whole sentence

- **What happened:** A 409 from Core read "Task state changed; read it and retry already exists", and Pulse answered "Pulse base is being deleted already exists" (#1326).
- **Root cause:** `err.conflict(what)` from `@k2b/stdlib` appended " already exists" to its argument, while about 390 of 395 calls in Cloud passed a whole sentence.
- **Error class:** A factory that completes a message the caller already wrote.
- **Guard:** `@k2b/stdlib` 0.33.0 takes the sentence as given and pins that in its own test. In Cloud the four calls that passed only a subject now write the sentence out, and the rule `conflict-sentences` reports an `err.conflict` literal of fewer than two words, which would now read as a bare word such as "Passkey"; it found exactly those four on the old code.
