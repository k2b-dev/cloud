### Fence acknowledgement across pruned publication history

- **What happened:** A stalled document publisher could pass an expected-empty-head CAS after another owner froze and pruned the tenant to empty. Rejected freeze preparation also blocked retries until expiry.
- **Root cause:** A prunable subject sequence was treated as a monotonic fence, and failed publication did not distinguish definite rejection from an uncertain outcome.
- **Error class:** ABA across retention and lease loss; incomplete compensation across a durable preparation boundary.
- **Guard:** The real-NATS room lifecycle regression releases an admission owner, freezes and prunes, then resumes its publication and verifies no acknowledgement and complete subsequent drainage. Unit tests cover definite-rejection compensation, uncertain outcomes, thaw retries and no-op repair. Lifecycle storage integration tests preserve fences across resizing, exhaustion and explicit retirement cleanup.
