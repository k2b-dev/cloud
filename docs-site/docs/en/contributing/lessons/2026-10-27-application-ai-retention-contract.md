### Application AI release and deletion must follow their declared identities

- **What happened:** Application AI release accepted active tasks, and deletion exposed prefix matching beyond the intended exact source selector.
- **Root cause:** The implementation broadened the lifecycle contract without matching its terminal-state and owner-identity constraints.
- **Error class:** Widening a lifecycle mutation beyond its declared state and identity boundary.
- **Guard:** Application AI integration tests reject release of queued, running and absent tasks, preserve idempotent terminal release, and prove exact source deletion retains neighboring snapshots and other owners. Mail integration tests cover transactional release, mailbox deletion, exact orphan reconciliation and stable request/hold recovery after a heartbeat aborts the inference observer.
