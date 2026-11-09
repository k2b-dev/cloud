### Socket transport fixtures erased unrelated adapter exports

- **What happened:** A Notebooks socket test failed while loading its application after the main sync, before its socket assertions could run.
- **Root cause:** Its module mock replaced all of `hono/bun` with an `upgradeWebSocket` hook. Transitive platform imports also needed another real adapter export, which the fixture had removed.
- **Error class:** A transport fixture replaces a module contract more broadly than the transport it owns.
- **Guard:** `packages/notebooks/src/ws-awareness.test.ts`, `ws-lineage.test.ts` and `ws-lifecycle.test.ts` snapshot the real adapter exports before overriding only the upgrade hook. Their application import and existing awareness, replay and shutdown assertions catch missing exports without changing the transport assertions.
