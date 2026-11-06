### Upload failures discarded progress or reused dead sessions

- **What happened:** Temporary Files upload failures discarded acknowledged segments; final publication conflicts and unknown receipts reused dead upload IDs ([#1166](https://github.com/k2b-dev/cloud/issues/1166)).
- **Root cause:** Adapters treated transfer failures alike, kept every commit key, and started browser uploads outside cleanup. The CLI ignored failed abort responses.
- **Error class:** Ordering and concurrency; silent failure.
- **Guard:** Shared status-classification tests, browser and CLI adapter tests, retention-boundary tests, and queue behavior tests cover transient preservation, confirmed aborts, fresh conflict/receipt retries, and expired keys. Filegate integration tests cover CLI resume after a network failure and managed-root publication conflicts.
