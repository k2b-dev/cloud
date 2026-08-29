---
id: pulse-data-model
title: Data model
icon: ti ti-stack-2
description: How sources, resources, signals, variants, and dimensions fit together.
order: 105
---
Pulse uses a small data model so different domains can share one query and dashboard language. Learn the nouns in the order you meet them while browsing data.

## The path from source to chart {icon="layout-dashboard"}

:::reference
- **Base:** A workspace with its own access, retention, sources, dashboards, and saved queries.
- **Source:** One connection that sends data to Pulse, such as a metrics endpoint, an HTTP ingest source, or another app.
- **Resource:** The observed object: host, container, device, customer, order, store, service, battery, or any domain object.
- **Signal:** A named metric, event, or state. The name says what happened or what was measured.
- **Variant:** One concrete signal shape for one source/resource/dimension set. Variants explain why one signal can have many rows or lines.
- **Dimension:** A label that distinguishes one variant from another, such as region, route, device, compose_service, channel, or customer_tier. Use reusable categories here rather than unique request or user values.
:::

## How to read repeated rows {icon="table"}

:::reference
- **Same signal, different resources:** `docker.container.cpu.usage` can appear once per container. Open the signal to see variants, or open the resource to see only one container.
- **Same resource, different dimensions:** A filesystem metric may appear once per mount. The dimensions show which mount, interface, route, region, or channel the row represents.
- **Same source, different domains:** A source can publish infrastructure data today and business events tomorrow. Pulse does not assume a fixed domain vocabulary.
:::

## Choose the right signal type {icon="route"}

:::reference
- **Metric: a number over time:** Use metrics for repeated measurements such as CPU usage, power, latency, or revenue. Keep dimensions stable so the list of variants remains useful.
- **Event: something happened:** Use events for visits, QR opens, orders, requests, deployments, and other point-in-time facts. Events can carry details with many possible values without creating a metric variant for each value.
- **State: what is true now:** Use states for online status, current version, operating mode, or another latest value. Pulse adds history only when the value actually changes.
:::

## Classify event fields {icon="table"}

:::reference
- **Dimensions filter and group:** Use labels with a stable set of values, such as campaign, channel, country, outcome, or environment. Query DSL `where` and `group by` use dimensions.
- **Attributes retain detailed context:** Use attributes for full URLs, request IDs, referrers, user agents, and irregular event detail that should remain visible on individual events.
- **Sensitive fields expire independently:** Use sensitive fields for IP addresses, precise geodata, and other protected event data. Normal event results do not show these fields, and Pulse can remove them sooner than the rest of the event.
- **Payload keeps supporting data together:** Use payload for nested domain data that you want to inspect as one object but do not need to filter or group.
- **Inventory describes available fields:** It shows observed dimension, attribute, and sensitive field names, roles, value types, counts, and timestamps. It does not list every stored field value.
- **Identities connect activity:** Use `actorId`, `sessionId`, and `correlationId` for people, sessions, and related activity. Pulse can count unique actors and sessions without adding them as dimensions.
- **Resources stay stable:** Create resources for browsable objects such as a campaign, QR code, host, or service. A visit, session, request, timestamp, or IP address is not a resource.
:::

:::note Resource in the UI, entity in the DSL
The UI says resource because it is easier to read. Query DSL uses `entity` for the same identifier and `entity_type` for the resource class. For example, `entity container:app-core` means one resource; `entity_type container` means all container resources.
:::
