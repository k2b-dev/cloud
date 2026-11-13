### Idle AI conversation heartbeats repeated database reads

- **What happened:** Each open conversation stream ran three SQL statements on every five-second heartbeat, even without model output.
- **Root cause:** The heartbeat reauthenticated the credential and loaded the conversation and its latest message.
- **Error class:** Database polling inside an idle streaming transport.
- **Guard:** The SQL budget in `ai/routes.integration.test.ts` pins admission and requires zero statements across live deltas and repeated heartbeat callbacks. Event-driven revocation tests and DATA-13 keep access changes on the existing Identity-Access and domain event paths.
