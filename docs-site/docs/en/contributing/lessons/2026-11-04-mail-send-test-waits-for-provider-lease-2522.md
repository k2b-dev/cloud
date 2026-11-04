### A direct send in a test met the draft worker's provider lease

- **What happened:** The Mail test "every settled send records one feed event…" failed in about one of four full runs of `sent-projection.integration.test.ts`. Its first send threw `REMOTE_RESOURCE_BUSY` before it reached SMTP, so no feed event existed yet.
- **Root cause:** The test sent its reply right after creating the draft. The suite's draft projection worker was still exporting that draft under the same provider lease. The outbox job resubmits a send that finds the lease busy, but the test called `executeOutboxSubmission` directly and got the error. The product never wrote a duplicate or missing `message.sent` event.
- **Error class:** A test calls a lease-guarded provider step directly while background workers in the same process can hold the lease, and treats routine contention as a failure.
- **Guard:** The suite's `send` helper waits through `whenProviderFree`, which now treats `REMOTE_RESOURCE_BUSY` like `SYNC_BUSY`, so each send waits its turn as the outbox job does. Forcing the lease busy for 500 ms before the send fails the test without the guard and passes with it.
