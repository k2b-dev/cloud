---
id: pulse-operate
title: Operate
icon: ti ti-lifebuoy
description: Source health, retention, access, public displays, and common symptoms.
order: 140
---
Use this page when data is missing, access needs to change, or a public display should show only one dashboard.

## Routine checks {icon="route"}

:::reference
- **Source health:** Sources show recent updates, duration, errors, received data, and API-key use where relevant.
- **Retention and clear data:** Detailed data, long-term summaries, and protected event fields can be kept for different periods. Protected fields can expire before the rest of an event. Clear all data to keep the base, sources, API keys, access, dashboards, saved queries, and settings while discarding collected data.
- **Access:** Base permissions control who can view, edit, or administer a base. Public dashboards are separate link-based read views.
- **Public displays:** Anyone with the public link can see that dashboard and its results, but not the base browsers, source settings, saved queries, or API keys. Use useful defaults because public viewers do not edit controls.
- **Long destructive operations:** Clearing or deleting a large base can take time after confirmation. An accepted request means the work started, not that all data disappeared immediately.
:::

## Send data with HTTP ingest {icon="point"}

:::reference
- **Requests are all or nothing:** Pulse rejects a request it cannot accept instead of keeping only part of its data. Split a rejected large request and retry each part separately.
- **API keys belong to one source:** Pulse assigns received signals to the source that owns the API key. A source value sent with the data does not change that assignment.
- **Retry-safe requests:** Send the same Idempotency-Key when retrying one batch. Pulse returns the original result for at least 24 hours and rejects reuse with different content.
- **Keep metric variants manageable:** A metric can have up to 10,000 variants in a base. Move request IDs, sessions, full URLs, IPs, and other unique values to events instead of metric dimensions.
:::

## Common symptoms {icon="lifebuoy"}

:::reference
- **No data appears:** Check the source first. It must report a successful update before resources, signals, or dashboards can show data.
- **A query matches too much:** Open Inventory or the signal page, then add source, entity, entity_type, or where filters.
- **A chart is empty:** Check the time range and aggregation. Counters usually need rate or increase; gauges usually need avg or latest.
- **Rows look duplicated:** Open the resource or signal page. Repeated rows are usually variants with different resources or dimensions.
- **A metric has too many variants:** Inspect its dimensions. Keep stable grouping labels, then move unique identities or event detail into an event's identity fields, attributes, sensitive fields, or payload.
:::
