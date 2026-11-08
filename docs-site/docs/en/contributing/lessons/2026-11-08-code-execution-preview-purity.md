### Keep execution previews free of presentation updates

- **What happened:** An owner manager could not preview pausing or resuming Code.
- **Root cause:** Permission evaluation also refreshed cached presentation metadata inside a read-only transaction.
- **Error class:** Mutation hidden in a read-only decision path.
- **Guard:** Execution review integration tests cover resource and application managers with matching and renamed owner titles; both pause and resume leave Code and account rows unchanged. Detail reads refresh presentation separately. The catch-up integration fixture routes owner-reader and historical-event responses separately, so normal detail refreshes exercise the real owner-view contract.
