### Stopping one replica removed routes for the survivors (#1561)

- **What happened:** A clean replica stop removed the shared app and capability entries. The gateway dropped the app’s routes until a survivor’s next refresh ([#1561](https://github.com/k2b-dev/cloud/issues/1561)).
- **Root cause:** Every replica wrote the same keys and deleted them unconditionally on stop. No membership check protected the shared entries from a stop racing a new replica’s start.
- **Error class:** Shared resource removed by one of several owners.
- **Guard:** The replica-membership cases in `heartbeat.test.ts` cover clean stops, surge races, TTL expiry, late writes, registry failures, a survivor replacing the entry of a departed newer replica, and a newer replica taking back an entry that an older one repaired. A stale stop snapshot cannot remove shared entries unless at least half the membership lease remains. `heartbeat.integration.test.ts` checks real Sync watches. The nightly scale-acceptance `chat-replica-stop` scenario checks gateway requests across a graceful stop and a surge rollout, and requires the container to be stopped with exit code 0 and no OOM kill before removal.
