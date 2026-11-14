### Replica replay tests wait for the applied cursor

- **What happened:** A replica reconnect test expected an update to replay before `ready`, but a delayed NATS publication correctly arrived after `ready` as a live update.
- **Root cause:** The test treated a committed outbox row followed by a 500 ms pause as proof that the other replica had applied the update. A second pause made the same assumption before testing ring eviction. The original CI deadline failure was not reproduced; the ordering race was reproduced by holding publication for 900 ms.
- **Error class:** Fixed-delay synchronization across asynchronous delivery stages.
- **Guard:** `events/live-routes.integration.test.ts` captures real NATS publication receipts and waits for the target replica's matching `progress` cursor before testing replay or eviction. It also holds publication until that replica reports its previous cursor. The five-second condition deadline remains unchanged; failure messages include observed cursors, frames, and socket closure.
