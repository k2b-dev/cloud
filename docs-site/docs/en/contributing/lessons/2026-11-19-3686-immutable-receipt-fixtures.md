### Insert mismatching evidence without rewriting immutable receipts

- **What happened:** Three alarm admission integration cases failed while preparing their fixtures, before either admission assertion ran.
- **Root cause:** The fixtures updated send receipt ownership, origin or input hash after insertion. The receipt immutability trigger correctly rejected these updates.
- **Error class:** A negative integration fixture violates a storage invariant before reaching the behavior it tests.
- **Guard:** The owner, origin and hash cases in `packages/core/src/ai-wakeup-admission.integration.test.ts` insert mismatching receipts once, retaining valid queue and message IDs. Both queue and worker admission must reject each mismatch, and no turn budget may be reserved. The database trigger remains enabled.
