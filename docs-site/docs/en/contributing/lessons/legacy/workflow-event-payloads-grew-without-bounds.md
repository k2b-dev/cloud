### Workflow event payloads grew without bounds

- **What happened:** Workflow events kept payloads and deliveries indefinitely and accepted arbitrarily large JSON ([#1183](https://github.com/k2b-dev/cloud/issues/1183)).
- **Root cause:** Emission had no byte limit, and finished events had no payload retention.
- **Error class:** Unbounded storage growth.
- **Guard:** Event integration cases cover UTF-8 size limits before SQL, retained dedupe rows, dispatch age, resumable runs, repeated retention batches, and concurrently built retention indexes. Observability integration cases distinguish expired payloads from missing events. Mail integration cases emit an oversized message without its body through sync and backfill, and retry failed runs after event expiry while excluding succeeded runs. Convention: emitters keep large content out of events and let runs read it by reference; history queries use retained run context when event context and deliveries expire.
