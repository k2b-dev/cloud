### Preserve ordered admission and transport ownership during extraction

- **What happened:** An extracted snapshot writer stopped producing structural receipts with an independent transport. Long room sessions replayed their entire unsaved history per edit, and a store-only restore left a window for old-generation acknowledgements.
- **Root cause:** The writer acquired a process-global Sync dependency instead of receiving its transport's lease. The room retained its join-time base, and restore authority traveled only through delayed domain events.
- **Error class:** A shared extraction changes runtime ownership or loses an ordering boundary.
- **Guard:** The table fuzz suite checks receipts and undo of the author's own concurrent edits without `app.start()`. Room tests bound replay and measure zero edit/idle SQL. Three concurrent editors on two room contexts assert one publish attempt per update through a shared admission lease. Event-cache tests verify covered state and receipts reuse one consumer and eviction never hides gaps. Real NATS tests fence remote edits at freeze/restore markers, verify exact drained persistence, and cover lease expiry and snapshot-writer contention.

Startup migrations also read policy through their supplied SQL transaction, including registered defaults. The pool-of-one identity suite guards against borrowing an unrelated settings connection during Core setup. Restore fixtures assert that validation, replay and marker publication all happen under the exclusive row lock before the replacement write.
