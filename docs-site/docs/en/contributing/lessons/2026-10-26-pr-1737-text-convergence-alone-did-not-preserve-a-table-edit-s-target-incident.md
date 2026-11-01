### Text convergence alone did not preserve a table edit's target

- **What happened:** Undoing an inserted column after another person's alignment could break the separator; deleting a moved value could be acknowledged without deleting its replacement.
- **Root cause:** Native text history and ordinary CRDT convergence did not record structural dependencies or validate the original target before acknowledgement.
- **Error class:** Confirming an operation whose text identities no longer represent its intended table cell.
- **Guard:** Shared-text structural history retains dependent columns, and admission validates delayed input against retained receipts. Fixed-seed table fuzz, native-history and effects-review regressions cover foreign text, alignment, multi-step Undo/Redo, and stale deletions.
