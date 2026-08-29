---
id: pulse-reference
title: Reference
icon: ti ti-book
description: Query, dashboard, and inventory lookup path.
order: 135
---
Use this reference to build queries and dashboards. Read the syntax sections for the available statements, then use Inventory to copy the exact names, source ids, resource ids, and dimensions from the current base.

Pulse bases, sources, dashboards, and saved queries use stable six-character IDs. Observed resources keep their domain identity; events, samples, series, and run records are telemetry data rather than independently addressable short-ID resources.

## What this reference covers {icon="layout-grid"}

:::info Query DSL
Fetch metric trends, individual or summarized events, and current states. The explorer and dashboard widgets use the same language.
:::

:::success Dashboard DSL
Describe dashboard controls, sections, cards, markdown notes, and visual widgets as text.
:::

:::info Inventory
Browse the current base. Filter by source or entity, then copy scoped snippets instead of memorizing names.
:::

## Work from known data {icon="shield-lock"}

:::reference
- **Start from the task:** Decide whether the question needs a metric trend, event rows, current states, or a dashboard view before choosing syntax.
- **Copy names from Inventory:** Metrics, events, states, sources, resources, and dimensions are observed data. Do not guess them from examples.
- **Keep resource and entity aligned:** The UI says resource. Query DSL says entity. They refer to the same identifier, such as container:app-core or customer:acme.
- **Keep the text readable:** Use explicit names, narrow scopes, and descriptions close to the charts they explain.
:::

## Common starting points {icon="square-plus"}

**Counter throughput**

```text
metric http_requests_total rate every 1m since 1h where route=/api
```

**Orders per hour**

```text
metric orders.created increase every 1h since 7d where channel=web
```

**Recent errors**

```text
events app.error since 24h where severity=critical limit 100
```

**Daily unique visitors**

```text
events page.viewed unique actor every 1d since 30d where channel=web
```

**Fresh integration states**

```text
states integration.online since 10m where integration=webshop limit 200
```
