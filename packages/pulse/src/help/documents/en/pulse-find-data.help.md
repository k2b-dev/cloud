---
id: pulse-find-data
title: Find data
icon: ti ti-database-search
description: Where to start when you know the source, resource, signal, or dashboard you need.
order: 110
---
The fastest way to build a useful query is to find the right source, resource, or signal first, then copy a scoped snippet.

## Choose the browser {icon="table"}

:::reference
- **Start with Sources when data is missing:** Sources answer whether Pulse received anything recently. Check this before changing queries or dashboards.
- **Start with Resources when you know the object:** Resources group the metrics, states, and events for one observed thing. This is the clearest path for hosts, containers, devices, customers, and orders.
- **Start with Metrics, Events, or States when you know the name:** Signal pages show variants, current values, dimensions, and query actions for one metric, event, or state.
- **Use Inventory as the lookup table:** Open Reference, then choose Inventory. Filter the live catalog by source or entity, inspect observed field roles, then copy scoped snippets into Query explorer or Dashboard DSL.
- **Save queries you will reuse:** Query explorer keeps run history for recent work. Save a stable query when it should remain available by name and description.
:::

## Narrow in this order {icon="search"}

:::steps
1. **Filter by source:** Use source when the same signal name appears in several systems or ingest pipelines.
2. **Filter by resource:** Use entity or entity_type when the question is about one observed object or a resource class.
3. **Filter by dimensions:** Use where for labels such as route, region, channel, compose_service, mount, or device.
4. **Change the aggregation last:** If the query points at the right data but the chart looks wrong, revisit avg/latest/rate/increase.
:::

:::note Why variants matter
A metric with 50 variants is usually not duplicated. It often means 50 containers, mounts, routes, regions, products, or other labeled slices published the same signal name.
:::
