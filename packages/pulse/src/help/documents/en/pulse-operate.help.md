---
id: pulse-operate
title: Operate a base
icon: ti ti-lifebuoy
description: Check source health, retention, access, send data with HTTP ingest, and fix common problems.
order: 140
---
Use this page to check source health, manage access, and send data.

## Connect the data store (Cloud administrators) {icon="database"}

Open **Administration → Pulse → Data store**. An operator provides a dedicated
ClickHouse instance, version 26.9 or newer. Choose the service password, get the
setup script and have the ClickHouse administrator run it. Then enter the address and
service credentials and choose **Check and connect**. Failed checks explain
what to fix and leave the saved connection unchanged.

The same workflow is available through `cld pulse admin store`. Provide
passwords only with `--password-file` or `--password-stdin`. Without this connection, only Pulse administration stays available.

## Check a base routinely {icon="route"}

:::reference
- **Source health:** **Sources** show recent updates, duration, errors, received data, and the use of API keys where relevant.
- **Access:** Access to a base controls who can view, edit, or manage it.
- **Retention:** Pulse can keep detailed data, long-term summaries, and protected event fields for different periods. Protected fields can expire before the rest of an event.
- **Clear data:** **Clear telemetry** discards the collected data. It keeps the base, sources, API keys, access, and settings.
- **Long destructive operations:** Clearing or deleting a large base can take time after you confirm it. An accepted request means that the work started, not that all data disappeared immediately.
:::

## Send data with HTTP ingest {icon="point"}

:::reference
- **Requests are all or nothing:** Pulse rejects a request that it cannot accept completely, instead of keeping only part of its data. Split a rejected large request and retry each part separately.
- **API keys belong to one source:** Pulse assigns received signals to the source that owns the API key. A source value sent with the data does not change that assignment.
- **Retry-safe requests:** Send the same `Idempotency-Key` when you retry one batch. Pulse returns the original result for at least 24 hours and rejects reuse with different content.
- **Keep metric variants manageable:** A metric can have up to 10,000 variants in a base. Move request IDs, sessions, full URLs, IPs, and other unique values to events instead of metric dimensions.
:::

## Fix common problems {icon="lifebuoy"}

:::reference
- **A metrics source is refused:** Pulse scrapes only public endpoints by default. Ask a Cloud administrator to release the host, host:port or CIDR for this base under Administration → Pulse → Internal targets. Then retry the source.
- **No data appears:** Check the source first. Check its last update and error message.
- **A metric has too many variants:** Inspect its dimensions. Keep stable grouping labels. Move unique identities or event details into the identity fields, attributes, sensitive fields, or payload of an event.
:::

## Recover a base {icon="database"}

A new base provisions its own database and becomes active before accepting
changes. Clearing keeps sources and tokens. Deletion
revokes tokens first and closes database read access. A
base in deletion stays on your Pulse overview until it is gone. If an operation fails,
choose **Retry**. A Cloud administrator can also retry it under Administration → Pulse
→ Bases, where profiles, limits and measured storage appear without contents.

Shorter retention needs confirmation of the cutoff, affected rows and estimated
bytes. For sensitive fields, it counts the fields that are cleared; the rows stay. Raw data allows 1–730 days by default (up to 3,650 by policy), rollups
1–3,650 days, and sensitive fields 1–8,760 hours. Sensitive fields expire by
column TTL during ClickHouse merges; current states do not expire.

A checkpoint mismatch or missing database blocks measurement writes. While
the block is active, you cannot clear the base. After
restoring matching backups, a Cloud administrator chooses **Recheck**. **Recreate**
discards measurements and starts empty. Other Cloud apps keep working
when Pulse is not configured.
