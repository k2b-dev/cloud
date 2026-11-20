### Delegated completion must survive every terminal path

- **What happened:** Queued cancellations and start failures left the source chat without a completion activity. An optional presentation chunk could block the whole chat, and retries could make an old result link select another answer.
- **Root cause:** Completion depended on the target-turn end alone, source reads ran outside the savepoint, and result projection trusted a reusable sequence. An island-wide preload made optional code a mount dependency.
- **Error class:** Incomplete terminal-path coverage and optional-effect coupling.
- **Guard:** `chat-done.integration.test.ts` covers queue removal/archive/refusal, savepoint recovery, bounded poison-item attempts, runtime-sweep finalization, owner-only batched previews and retry-safe links. Completion render/behavior tests cover eager first-frame activities, target-specific action names and answer-detail loading/retry feedback; `island-bundles` enforces the unchanged byte budgets.
