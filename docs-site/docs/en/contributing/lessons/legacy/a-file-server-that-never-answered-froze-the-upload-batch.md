### A file server that never answered froze the upload batch

- **What happened:** A transfer request that the file server never answered left the upload row working with no message, and the rest of the batch waited ([#1163](https://github.com/k2b-dev/cloud/issues/1163)).
- **Root cause:** The Filegate SDK sets no request deadline ([k2b-dev/filegate#5](https://github.com/k2b-dev/filegate/issues/5)), and Cloud passed none. A plain per-request timeout is not enough: the SDK retries a thrown fetch error unless its upload signal is aborted, so each deadline would run three times.
- **Error class:** Silent failure.
- **Guard:** `upload-transfer.test.ts` checks one attempt per expired deadline, stalled response bodies, caller cancellation, and completed-request listener cleanup. CLI tests cover preparation deadlines and localized errors; `filegate-transfer.integration.test.ts` checks retained acknowledged bytes after a stalled second segment.
