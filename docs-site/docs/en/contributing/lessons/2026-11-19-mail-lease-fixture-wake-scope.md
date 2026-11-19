### Scope simulated workers to the mailbox they measure

- **What happened:** A provider lease fairness test reported a folder batch while its target mailbox's lease was held, blocking an unrelated merge queue entry.
- **Root cause:** Its virtual worker drained a process-wide wake map, including jobs for other mailboxes whose leases were free. Their batches inflated the target mailbox's counts; the real mutex remained required for every provider operation.
- **Error class:** Shared fixture work leaking across resource boundaries.
- **Guard:** `provider-lease-fairness.integration.test.ts` parks and releases a second mailbox's folder before measuring the held mailbox. The simulated worker consumes only its own folder wakes, leaves the unrelated wake intact, and retains the exact busy/batch and wake-count assertions. Its thirty sequential folder batches have an explicit real-I/O timeout, so a slow drain does not outlive the test and interfere with the next fixture.
