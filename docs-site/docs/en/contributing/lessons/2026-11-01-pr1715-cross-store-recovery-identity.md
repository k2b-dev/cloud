### A receipt and its measurement store had no shared recovery boundary

- **What happened:** After restoring a backup, a retried delivery could return a saved result for measurements the restored store no longer held.
- **Root cause:** Receipts in Postgres and measurements in ClickHouse recover independently, and nothing tied a receipt to a store checkpoint.
- **Error class:** Cross-store recovery identity.
- **Guard:** Test: Pulse `service/recovery.integration.test.ts` restores a checkpoint, replays the original event and state identities, covers partially pending checkpoints and quota-free completed retries, and fences scrape leases and failed rollups across clear or revision changes.
