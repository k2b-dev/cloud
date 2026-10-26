### Workflow inference must expire even when its transport stays alive

- **What happened:** Keepalive-only providers could occupy a worker indefinitely; expired or evicted coalesced NATS messages could leave a workflow waiting forever.
- **Root cause:** Stream idle timeouts and startup resubmission were treated as an absolute execution and delivery guarantee.
- **Error class:** Transport liveness is mistaken for bounded task completion.
- **Guard:** Queue integration tests also cover startup resubmission isolation and local concurrency matching global admission. Store tests preserve cancellation during expiry and repair missing terminal wakes. `workflows/ai/runtime.test.ts` bounds a non-settling runner and verifies provider cancellation. `store.integration.test.ts` expires a missing delivery and verifies the durable wake signal. `queue.integration.test.ts` verifies reject-on-full preserves accepted coalesced work.
