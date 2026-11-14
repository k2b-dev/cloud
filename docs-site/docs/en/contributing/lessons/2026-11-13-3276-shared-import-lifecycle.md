### Shared import recovery must distinguish input from lifecycle markers

- **What happened:** A failed import before the first shared join stranded log markers and blocked pruning. External edits after Undo or a rejected send became recovery copies. Rejected recovery restores added another copy on every retry.
- **Root cause:** Imports replaced an unseeded generation and treated any log tail as pending edits. Recovery restoration retained the previous version before shared admission succeeded, even when its error result committed the transaction.
- **Error class:** Lifecycle bookkeeping is mistaken for user input, and rejected operations commit success-only side effects.
- **Guard:** Sent-projection integration tests force an import rollback, verify retry and global prune coverage, and import external edits after real Undo and SMTP rejection. The compose-template integration test retries rejected shared restores with missing revision history and incomplete document history, asserting an unchanged recovery list. The socket integration SQL meter continues to require zero statements per room edit.
