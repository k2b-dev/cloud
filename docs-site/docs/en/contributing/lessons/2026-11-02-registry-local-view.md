### Registry reads repeated transport work on every request

- **What happened:** Concurrent page-like reads repeatedly listed NATS keys and fetched the same app records, delaying requests and the event loop.
- **Root cause:** `getApp` and `listApps` took a fresh ephemeral snapshot on each call. Each accepted entry was also validated twice. Capability manifests live in a separate registry; app-record validation did not explain the measured delay.
- **Error class:** Repeated transport work for unchanged shared state.
- **Guard:** `registry-view.integration.test.ts` checks public readers for zero additional snapshots, transport requests, or parsing of unchanged revisions, and checks access-rule changes and removal. `registry-view.test.ts` covers renewal, local TTL expiry, watch loss, failed refresh, and resync.
