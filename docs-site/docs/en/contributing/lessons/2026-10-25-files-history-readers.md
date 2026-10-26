### A filtered page masquerades as batch context

- **What happened:** A search hides visible peers and a page count is displayed as the whole batch, or a raw total discloses hidden peers.
- **Root cause:** A filtered page masquerades as batch context.
- **Error class:** A filtered page masquerades as batch context.
- **Guard:** Tests: Files `service/activity-batch.test.ts` and `service/activity-reader.integration.test.ts` anchor counts on a freshly projected event, apply the same local Cloud grant scope to peers, and mark the 500-candidate bound as a lower bound.
