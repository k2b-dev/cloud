---
id: pulse-find-data
title: Find data
icon: ti ti-database-search
description: Choose where to start when you know the source, resource, signal, or dashboard that you need.
order: 110
---
To build a useful query fast, first find the right source, resource, or signal. Then copy a scoped snippet.

## Choose where to browse {icon="table"}

:::reference
- **Start with Sources when data is missing:** **Sources** show whether Pulse received anything recently. Check this before you change queries or dashboards.
- **Start with Resources when you know the object:** **Resources** group the metrics, states, and events of one observed thing. This is the clearest path for hosts, containers, devices, customers, and orders.
- **Start with Metrics, Events, or States when you know the name:** A signal page shows variants, current values, dimensions, and query actions for one metric, event, or state.
- **Use Inventory to look up names:** Open **Reference**, then choose **Inventory**. Filter the live catalog by source or resource, and inspect the observed field roles. Then copy scoped snippets into the **Query explorer** or into Dashboard DSL.
- **Save queries that you reuse:** The **Query explorer** keeps a run history of recent work. Save a stable query when you want to keep it available by name and description.
:::

## Narrow in this order {icon="search"}

:::steps
1. **Filter by source:** Use `source` when the same signal name appears in several systems or ingest pipelines.
2. **Filter by resource:** Use `resource` or `resource_type` when the question is about one observed object or a resource class.
3. **Filter by dimensions:** Use `where` for labels such as route, region, channel, `compose_service`, mount, or device.
4. **Change the aggregation last:** The query can point at the right data while the chart looks wrong. Then revisit `avg`, `latest`, `rate`, or `increase`.
:::

:::note Why variants matter
A metric with 50 variants is usually not duplicated. Often 50 containers, mounts, routes, regions, products, or other labeled slices published the same signal name.
:::
