### Bound upload occupancy by access subject

- **What happened:** One caller could occupy both local PDF upload places with slow request bodies, excluding everyone else until the deadline.
- **Root cause:** The route bounded aggregate memory but did not limit simultaneous requests by the resolved access subject.
- **Error class:** A global concurrency ceiling permits one principal to exhaust availability.
- **Guard:** `packages/tools/src/api/pdf-tools.test.ts` holds one upload open, rejects a second request from the same user or service account before reading its body, admits another subject, and verifies recovery after cancellation. The existing two-subject saturation guard retains the global memory ceiling.
