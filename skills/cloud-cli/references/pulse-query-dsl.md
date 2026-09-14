# Pulse Query DSL

Pulse Query DSL selects metrics, events, or current states from one Pulse base. Use it with `cld pulse query compile`, `cld pulse query run`, saved queries, and Dashboard DSL widgets.

## Contents

- [Choose a statement](#choose-a-statement)
- [Metric queries](#metric-queries)
- [Event queries](#event-queries)
- [State queries](#state-queries)
- [Shared filters](#shared-filters)
- [Quoting and exact names](#quoting-and-exact-names)
- [Compile and run](#compile-and-run)
- [Limits and performance](#limits-and-performance)
- [Examples](#examples)

## Choose a statement

| Question | Statement | Result |
| --- | --- | --- |
| How did a numeric value change? | `metric` | Ordered points over time |
| What happened? | `events` | Event rows ordered by time |
| What is true now? | `states` | Latest current-state rows |

Start with Inventory, Resources, Metrics, Events, or States to discover exact signal and resource names. Use `cld pulse fields list --json` to discover field roles and dimension keys. Do not guess names from examples.

## Metric queries

```text
metric <metric> <aggregation>
  [every <duration>]
  [since <duration>]
  [source <source-id>]
  [resource <id>]
  [resource_type <type>]
  [where <key>=<value>, ...]
```

The metric name and aggregation are required. Defaults are:

- `every 5m`
- `since 24h`

`every` defines the time-window width. `since` defines the lookback window. Durations use positive integers followed by `m`, `h`, or `d`, and may not exceed `90d`.

```text
metric system.memory.usage avg
metric system.memory.usage avg every 1m since 6h
```

### Aggregations

| Aggregation | Meaning |
| --- | --- |
| `avg` | Average all matched values in each time window. |
| `sum` | Sum all matched values in each time window. |
| `min` | Smallest matched value in each time window. |
| `max` | Largest matched value in each time window. |
| `count` | Number of matched samples in each time window, not the sum of their values. |
| `latest` | Latest sample per matched variant in each time window, then average those latest values. |
| `rate` | Average non-negative per-second change across matched variants in each time window. Counter resets are ignored. |
| `increase` | Average non-negative counter increase across matched variants in each time window. Counter resets are ignored. |
| `p50` | 50th percentile of matched values in each time window. |
| `p90` | 90th percentile of matched values in each time window. |
| `p95` | 95th percentile of matched values in each time window. |
| `p99` | 99th percentile of matched values in each time window. |

Use `rate` or `increase` for counters when the question is about change. Use `avg`, `latest`, `min`, or `max` for gauges depending on the question.

Metric output has at most 2,000 ordered points. If a range produces too many points, shorten `since` or increase `every`.

## Event queries

```text
events [<kind>|*]
  [count|sum|unique actor|unique session]
  [every <duration>]
  [group by <dimension>, ...]
  [since <duration>]
  [source <source-id>]
  [resource <id>]
  [resource_type <type>]
  [where <key>=<value>, ...]
  [limit <rows>]
```

Defaults are:

- all event kinds when the kind is omitted or `*`
- individual event rows when no aggregation is specified
- `every 1h` for summarized events
- `since 24h`
- `limit 500`

```text
events deploy.finished since 7d where env=prod limit 100
events * since 1h resource_type service limit 200
events page.viewed count every 1h since 7d where channel=qr group by campaign, country
events page.viewed unique actor every 1d since 30d
```

Without an aggregation, event rows include the event kind and timestamp, optional numeric value, source and resource identifiers, dimensions, attributes, payload, and recorded timestamp. Individual rows intentionally omit sensitive fields and actor, session, and correlation identities.

### Event aggregations

| Aggregation | Meaning |
| --- | --- |
| `count` | Count matched events per time window and optional dimension group. |
| `sum` | Sum non-null event `value` fields per time window and optional dimension group. |
| `unique actor` | Count distinct non-null `actorId` values per time window and optional dimension group. |
| `unique session` | Count distinct non-null `sessionId` values per time window and optional dimension group. |

Summarized events return points over time instead of individual event rows. `every` defaults to `1h`. `group by` accepts one to four dimension keys and groups missing values as a separate empty group. Grouping applies only to `dimensions`, not `attributes`, `sensitive`, or `payload`.

The event aggregation must follow the event kind directly. `every` and `group by` require an aggregation. Shared clauses such as `since`, `source`, `resource`, `resource_type`, `where`, and `limit` may follow in any order.

```text
events qr.opened count every 1h since 7d group by campaign, country
events page.viewed unique actor every 1d since 30d where channel=web
events order.created sum every 1h since 24h group by currency
```

Use `actorId` and `sessionId` for unique counts. Do not duplicate unique identities into dimensions. Query DSL does not currently filter individual events by actor, session, correlation, attributes, sensitive fields, or payload.

## State queries

```text
states [<key>|*]
  [since <duration>]
  [source <source-id>]
  [resource <id>]
  [resource_type <type>]
  [where <key>=<value>, ...]
  [limit <rows>]
```

Defaults are:

- all state keys when the key is omitted or `*`
- no freshness filter
- `limit 500`

States are current values, not a state-change history. Add `since` only when stale current values should disappear.

```text
states integration.online resource service:webshop
states * since 10m resource_type device limit 200
```

State rows include the key, current value, source and resource identifiers, dimensions, and last update time.

## Shared filters

Filters may appear after the statement-specific fields in any order. Each clause may appear at most once.

### `source <source-id>`

Restricts the query to one source. Query DSL requires the source's six-character ID; unlike CLI `--source`, it does not resolve source names.

```text
source Src001
```

Resolve the ID first:

```bash
cld pulse sources list --json
```

### `resource <id>`

Restricts the query to one complete `type:id` resource key. Use the key shown by the resource inventory.

```text
resource container:app-core
```

### `resource_type <type>`

Restricts the query to one resource class. Types come from observed data and are not a fixed server-only enum.

```text
resource_type container
resource_type customer
```

Use the exact spelling `resource_type`. Historical entity clauses and alternate spellings are rejected.

### `where <key>=<value>, ...`

Applies exact dimension matches. Multiple pairs are combined with AND.

```text
where env=prod, region=eu
where route=/checkout method=POST
```

The comma is optional between pairs. A `where` clause must contain at least one valid `key=value` pair.

### `since <duration>`

Defines a lookback window. For states, it is a freshness filter on `updatedAt`.

```text
since 15m
since 24h
since 30d
```

### `limit <rows>`

Applies to events and states. It must be a positive integer no larger than 1,000.

## Quoting and exact names

Single and double quotes are supported. Quote metric names, event kinds, state keys, resource IDs, types, dimension keys, or values when they contain spaces, commas, or equals signs.

```text
events "checkout error" where message="payment, provider=offline" limit 50
states "integration label" resource "service:web shop"
```

Inside a quoted token, backslash escapes the next character:

```text
where message="customer said \"retry\""
```

Statement and clause keywords are case-insensitive. Metric aggregations use the lowercase spelling shown in this reference. Observed names and filter values keep their spelling and should match the data exactly.

## Compile and run

Pass a query as one argument, a file, or stdin:

```bash
cld pulse query compile --query 'metric orders.created increase every 1h since 7d' --json
cld pulse query run --file query.pulse --json
cat query.pulse | cld pulse query run --stdin --json
```

Compile output:

```json
{
  "ok": true,
  "diagnostics": [],
  "compiled": {
    "kind": "events",
    "event": "deploy.finished",
    "since": "24h",
    "sourceId": null,
    "resourceKey": null,
    "resourceType": null,
    "dimensions": { "env": "prod" },
    "limit": 100
  }
}
```

Run output always contains `compiled`, `points`, `events`, and `states`. Exactly one data collection is populated for a valid statement:

```json
{
  "compiled": { "kind": "events" },
  "points": [],
  "events": [
    {
      "id": "event-uuid",
      "kind": "deploy.finished",
      "ts": "2026-07-12T12:00:00.000Z",
      "value": null,
      "sourceId": "Src001",
      "resourceKey": "service:checkout",
      "resourceType": "service",
      "dimensions": { "env": "prod" },
      "attributes": { "releaseId": "release-123" },
      "payload": { "version": "1.2.3" },
      "recordedAt": "2026-07-12T12:00:01.000Z"
    }
  ],
  "states": []
}
```

## Limits and performance

- Query text is limited to 2,000 characters by the API and CLI.
- Durations must be positive and no longer than 90 days.
- Event and state result limits may not exceed 1,000 rows.
- Event aggregations may group by at most four dimension keys and return at most 1,000 ordered points.
- Metric execution rejects queries matching more than 250 variants.
- Metric output is limited to 2,000 time windows.
- A `where` clause accepts at most 32 distinct dimension filters.
- A clause may appear only once.

When a metric matches too many variants, inspect them with `cld pulse series <metric> --json`, then add `source`, `resource`, `resource_type`, or `where` filters. Do not silently choose an arbitrary variant.

## Examples

### Current gauge value

```text
metric battery.charge_percent latest every 5m since 24h resource battery:garage
```

### Counter throughput

```text
metric http_requests_total rate every 1m since 1h where route=/api
```

### Counter increase per hour

```text
metric orders.created increase every 1h since 7d where channel=web
```

### Latency percentile

```text
metric http_request_duration_seconds p95 every 5m since 24h where route=/checkout
```

### Recent errors

```text
events app.error since 24h where severity=critical limit 100
```

### Fresh current states

```text
states integration.online since 10m where integration=webshop limit 200
```

Return to the [Pulse CLI reference](pulse.md) for discovery, saved queries, dashboards, sources, and access.
