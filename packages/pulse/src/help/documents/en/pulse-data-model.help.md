---
id: pulse-data-model
title: Understand the data model
icon: ti ti-stack-2
description: See how bases, sources, resources, signals, variants, and dimensions fit together.
order: 105
---
Pulse groups incoming measurements by base and source.

## Follow the path from source to measurement {icon="layout-dashboard"}

:::reference
- **Base:** A workspace with its own access, retention, and sources.
- **Source:** One connection that sends data to Pulse, such as a metrics endpoint, an HTTP ingest source, or another app.
- **Resource:** The observed object: a host, container, device, customer, order, store, service, battery, or any domain object.
- **Signal:** A named metric, event, or state. The name says what happened or what was measured.
- **Variant:** One concrete signal shape for one combination of source, resource, and dimensions. Variants explain why one signal can have many rows or lines.
- **Dimension:** A label that distinguishes one variant from another, such as region, route, device, `compose_service`, channel, or `customer_tier`. Use reusable categories here, not unique request or user values.
:::

## Choose the right signal type {icon="route"}

:::reference
- **Metric: a number over time:** Use metrics for repeated measurements such as CPU usage, power, latency, or revenue. Keep dimensions stable, so the list of variants stays useful.
- **Event: something happened:** Use events for visits, QR opens, orders, requests, deployments, and other facts at one point in time. Events can carry details with many possible values without a metric variant for each value.
- **State: what is true now:** Use states for online status, current version, operating mode, or another latest value. Pulse adds history only when the value actually changes.
:::

## Classify event fields {icon="table"}

:::reference
- **Dimensions filter and group:** Use dimensions for labels with a stable set of values, such as campaign, channel, country, outcome, or environment.
- **Attributes keep detailed context:** Use attributes for full URLs, request IDs, referrers, user agents, and irregular event details that you want to keep visible on single events.
- **Sensitive fields expire on their own:** Use sensitive fields for IP addresses, precise geodata, and other protected event data. Pulse can remove them sooner than the rest of the event.
- **Payload keeps supporting data together:** Use the payload for nested domain data that you want to inspect as one object but do not need to filter or group.
- **Identities connect activity:** Use `actorId`, `sessionId`, and `correlationId` for people, sessions, and related activity. Keep these identities out of dimensions.
- **Resources stay stable:** Create resources for stable objects such as a campaign, QR code, host, or service. A visit, session, request, timestamp, or IP address is not a resource.
:::

:::note Explicit resources
Send `resource: {type, id, label?}` to associate a signal with an object. Omit it for a signal without a resource. Pulse does not infer objects from generic ingest dimensions. Resource types are lowercase slugs. Metrics and states from different sources stay separate variants.
:::
