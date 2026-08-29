---
id: pulse-query-language
title: Query DSL
icon: ti ti-terminal-2
description: Metric, event, and state query syntax with aggregations and examples.
order: 120
---
Query DSL answers one data question at a time. Pick whether you need a metric trend, individual or summarized events, or current states, then narrow the query with source, resource, and dimension filters.

## Pick the statement by question {icon="point"}

- **How did a number change?** Use `metric`. Add an aggregation such as `avg`, `latest`, `rate`, or `increase`.
- **What happened recently?** Use `events`. Return individual rows for inspection, or count, sum, and count unique actors or sessions over time.
- **What is true now?** Use `states`. States return the latest known value for facts such as online status, version, configuration, inventory, or current health.

## Build a query in four steps {icon="search"}

:::steps
1. **Name the signal:** Choose the metric, event kind, or state key from the UI or Inventory.
2. **Choose the shape:** Metrics need an aggregation. Events can return rows or use count, sum, or unique aggregation.
3. **Set the time range:** Use since for the range, and every for metric or summarized-event time windows.
4. **Narrow the scope:** Add source, entity, entity_type, or where filters when the result includes too many variants or rows.
:::

## Statement types {icon="book-2"}

**Metric**

```text
metric <metric> <aggregation>
  [every <duration>]
  [reduce <sum|avg|min|max>]
  [group by <resource|dimension>]
  [since <duration>]
  [source <source-id>]
  [entity <id>]
  [entity_type <type>]
  [where <key>=<value>, ...]
```

**Events**

```text
events [<kind>|*]
  [count|sum|unique actor|unique session]
  [every <duration>]
  [group by <dimension>, ...]
  [since <duration>]
  [source <source-id>]
  [entity <id>]
  [entity_type <type>]
  [where <key>=<value>, ...]
  [limit <rows>]
```

**States**

```text
states [<key>|*]
  [since <duration>]
  [source <source-id>]
  [entity <id>]
  [entity_type <type>]
  [where <key>=<value>, ...]
  [limit <rows>]
```

Shared clauses may follow the statement-specific fields in any order. Write each clause at most once. Metric `group by` accepts one resource or dimension group. Event aggregation must follow the event kind directly; summarized events accept up to four dimension groups.

## Examples {icon="point"}

**Current value for one device**

```text
metric battery.charge_percent latest every 5m since 24h where device="garage-battery"
```

Use latest when the newest gauge value matters more than the average trend.

**Trend over time**

```text
metric solar.output_watts avg every 15m since 7d where inverter=main
```

Use avg to smooth noisy gauge samples without changing the unit.

**Throughput from a counter**

```text
metric http_requests_total rate every 1m since 1h where route=/api
```

Use rate when a counter keeps growing and you want per-second throughput.

Pulse computes rate per matched variant, then averages matched variants by default. Use `reduce sum` for total throughput and `group by resource` for one series per resource.

```text
metric http_requests_total rate every 1m reduce sum group by resource since 1h
```

**Business volume over time**

```text
metric orders.created increase every 1h since 7d where channel=web
```

Use increase when the question is how many new things happened inside each time window.

Pulse computes increase per matched variant, then averages matched variants by default. Add `reduce sum` when the variants form one total.

**Fleet CPU by resource**

```text
metric system.cpu.usage avg every 5m group by resource since 24h
```

**Filesystem usage by mount dimension**

```text
metric system.filesystem.usage max every 5m group by mount since 24h
```

**Recent events**

```text
events deploy.finished since 7d where env=prod limit 100
```

Use individual events for rows you want to inspect or audit.

**Daily unique visitors**

```text
events page.viewed unique actor every 1d since 30d where channel=web
```

Use `actorId` for unique visitor counts instead of creating one dimension value per visitor.

**Current states**

```text
states integration.enabled entity "webshop" limit 50
```

Use states for current truth. Add since only when stale values should disappear.

## Clause reference {icon="search"}

| Clause | Applies to | Meaning | Example |
| --- | --- | --- | --- |
| `metric <metric> <aggregation>` | metric | Select one numeric signal and define how samples are reduced. Metrics default to every 5m since 24h. | `metric orders.created increase` |
| `reduce <sum\|avg\|min\|max>` | metric | Combine the per-variant values inside each output group. The default is `avg`. | `reduce sum` |
| `group by <resource\|dimension>` | metric | Return one output series per resource or one dimension value. Without it, all matched variants form one output group. | `group by resource` |
| `events [<kind>\|*]` | events | Return event rows by kind. Omit the kind or use * for all events. Events default to since 24h limit 500. | `events deploy.finished` |
| `count \| sum \| unique actor \| unique session` | events | Summarize matched events over time instead of returning individual rows. | `events page.viewed unique actor every 1d since 30d` |
| `group by <dimension>, ...` | summarized events | Split an event summary by one to four dimensions. | `group by campaign, country` |
| `states [<key>\|*]` | states | Return current state rows by key. Omit the key or use * for all states. States default to limit 500 with no stale-time filter. | `states host.online` |
| `every <duration>` | metric, summarized events | Group metric values or summarized events into fixed time windows. Use compact durations such as 5m, 1h, or 7d. | `every 15m` |
| `since <duration>` | metric, events, states | Limit by time. Durations use m, h, or d and may not exceed 90 days. For states, since hides stale current values. | `since 7d` |
| `source <source-id>` | all | Restrict results to one source. The value must be a valid source ID copied from Pulse. | `source Src001` |
| `entity <id>` | all | Restrict results to one resource identifier. The UI calls this a resource; Query DSL calls it an entity. | `entity container:app-core` |
| `entity_type <type>` | all | Restrict results to one resource class such as host, container, service, device, order, or customer. | `entity_type container` |
| `where <key>=<value>` | all | Filter dimensions by exact equality. Separate multiple filters with commas; one query accepts up to 32 filters. | `where env=prod, region=eu` |
| `limit <rows>` | events, states | Limit returned rows. Use a positive integer no larger than 1000. | `limit 100` |

## Names, quotes, and exact matching {icon="brackets"}

Statement and clause keywords are case-insensitive. Metric aggregations use the lowercase spelling shown in this reference. Signal names, resource identifiers, dimension keys, and values keep their spelling and match observed data exactly.

Use single or double quotes around names and values containing spaces, commas, or equals signs:

```text
events "checkout error" where message="payment, provider=offline" limit 50
states "integration label" entity 'service:web shop'
```

Inside a quoted value, backslash escapes the next character:

```text
events app.error where message="customer said \"retry\""
```

Commas between `where` filters and between `group by` keys are optional. They improve readability but do not change the query.

## Aggregations {icon="point"}

Choose aggregation from the shape of the data, not from the chart you want. Gauges describe a value at a time, counters only grow, and latency distributions need percentiles.

| Aggregation | Meaning | Best for | Example |
| --- | --- | --- | --- |
| `avg` | Average samples per variant in each time window. | Gauges such as utilization, temperature, output, or quality scores. | `metric solar.output_watts avg every 15m since 7d` |
| `latest` | Take the latest sample per variant in each time window. | Current gauges and status numbers. | `metric battery.charge_percent latest every 5m since 24h` |
| `min / max` | Smallest or largest value in each time window. | Dips, peaks, and capacity checks. | `metric inventory.stock_level max every 1h since 30d` |
| `sum` | Add samples per variant in each time window. | Values whose temporal sum is meaningful. | `metric sales.revenue sum every 1h since 7d` |
| `count` | Count samples per variant, not their values. | Sample presence and collection checks. | `metric website.visitors count every 1h since 7d` |
| `rate` | Compute change per second per variant and ignore counter resets. | Requests/sec, bytes/sec, and throughput. | `metric http_requests_total rate every 1m since 1h` |
| `increase` | Compute increase per variant and ignore counter resets. | Orders, visitors, requests, or bytes per time window. | `metric sales.orders increase every 1h since 7d` |
| `p50 / p90 / p95 / p99` | Find a percentile in each time window. | Latency and distribution metrics. | `metric http_request_duration_seconds p95 every 5m since 24h` |
| `events count / sum` | Count events or sum their numeric value in each time window. | Visits, orders, errors, revenue, and other point-in-time facts. | `events order.created sum every 1h since 7d group by currency` |
| `events unique actor / session` | Count distinct actorId or sessionId values in each time window. | Visitors, active users, sessions, and engagement without unique identities in dimensions. | `events page.viewed unique actor every 1d since 30d` |

## Rules that matter {icon="book-2"}

:::info Metrics summarize values
`metric` requires a metric and aggregation. Use `every` to choose time windows and `since` to define the time range.
:::

:::note Metric queries use two reduction stages
Pulse first applies the metric aggregation independently to every matched variant. It then combines those values with `reduce`, which defaults to `avg`. Add `group by resource` or `group by <dimension>` to create multiple output series. Use `reduce sum` for fleet totals or for counters split across interfaces.
:::

:::success Events return rows or points
`events` starts as table output. Add `count`, `sum`, `unique actor`, or `unique session` to show a trend over time. `states` returns current rows. Use `source`, `entity`, `entity_type`, `where`, and `limit` to narrow them.
:::

:::info Names and values
Use `*` or omit the name for all events or all states. `source` accepts a six-character Source ID, while `entity` accepts the exact resource identifier shown by Pulse.
:::

:::warning Performance limits
Query text is limited to 2,000 characters. Metric queries stop when more than 250 variants match, when the requested range creates more than 2,000 time windows, or when grouped output would exceed 100,000 points. Add `source`, `entity`, or `where` filters, shorten `since`, or increase `every`. Event and state results are capped at 1,000 rows; event summaries accept at most four group keys and return at most 1,000 points.
:::
