---
id: pulse-operate
title: Operate a base
icon: ti ti-lifebuoy
description: Check source health, retention, access, and public displays, send data with HTTP ingest, and fix common problems.
order: 140
---
Use this page when data is missing, when access must change, or when a public display must show only one dashboard.

## Check a base routinely {icon="route"}

:::reference
- **Source health:** **Sources** show recent updates, duration, errors, received data, and the use of API keys where relevant.
- **Access:** Access to a base controls who can view, edit, or manage it. Public dashboards are separate read-only views behind a link.
- **Public displays:** Anyone with the public link can see that dashboard and its results. They cannot see the browsers of the base, the source settings, saved queries, or API keys. Choose useful defaults, because public viewers do not edit controls.
- **Retention:** Pulse can keep detailed data, long-term summaries, and protected event fields for different periods. Protected fields can expire before the rest of an event.
- **Clear data:** **Clear telemetry** discards the collected data. It keeps the base, sources, API keys, access, dashboards, saved queries, and settings.
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
- **No data appears:** Check the source first. It must report a successful update before resources, signals, or dashboards can show data.
- **A query matches too much:** Open **Inventory** or the signal page. Then add `source`, `resource`, `resource_type`, or `where` filters.
- **A chart is empty:** Check the time range and the aggregation. Counters usually need `rate` or `increase`. Gauges usually need `avg` or `latest`.
- **Rows look duplicated:** Open the resource or signal page. Repeated rows are usually variants with different resources or dimensions.
- **A metric has too many variants:** Inspect its dimensions. Keep stable grouping labels. Move unique identities or event details into the identity fields, attributes, sensitive fields, or payload of an event.
:::
