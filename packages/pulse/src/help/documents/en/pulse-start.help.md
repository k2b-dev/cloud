---
id: pulse-start
title: Start with Pulse
icon: ti ti-activity-heartbeat
description: Learn where to start for each task, and take the first path from a new base to a dashboard.
order: 100
---
Pulse turns incoming data into browsable facts, query results, and dashboards. The Pulse overview lists every base that you can access. There you create or open a base before you select any source or signal. Start from your question. The interface then shows the source, resource, signal, and filters that you need.

## Start from the task {icon="square-plus"}

:::reference
- **Check whether data arrives:** Open **Sources** first. For each connection, it shows recent updates, errors, received data, and the use of API keys.
- **Understand one observed thing:** Open **Resources** when you care about one host, container, device, customer, order, store, or app. This keeps metrics, states, and events in the same context.
- **Inspect one named fact:** Open **Metrics**, **Events**, or **States** when you already know the name, such as `system.memory.usage` or `order.created`.
- **Build a query:** Use the **Query explorer** to test one metric, event, or state query. Copy filters from **Inventory** instead of memorizing labels.
- **Build a dashboard:** Use Dashboard DSL when the query is stable. Dashboards are text documents with controls, sections, rows, cards, widgets, and notes.
:::

## Go from a new base to a dashboard {icon="route"}

:::steps
1. **Create a base:** Use one base for one product, environment, business area, or reporting context.
2. **Connect a source:** Add a metrics endpoint or an HTTP ingest source. Wait until Pulse reports received data.
3. **Browse what exists:** Use **Resources** when you know the object. Use **Metrics**, **Events**, or **States** when you know the signal name.
4. **Open a query:** Start with a copied query snippet. Narrow it with `source`, `resource`, `resource_type`, or `where` filters.
5. **Save the query:** Save stable queries that you expect to reuse.
6. **Write the dashboard:** Move useful, stable queries into Dashboard DSL. Add descriptions when a chart needs interpretation.
:::

:::note One naming rule
Signal names describe the fact, such as `orders.created` or `system.cpu.usage`. Source, resource, and dimensions describe where that fact came from. So the same model works for servers, sales, websites, energy systems, and app workflows.
:::
