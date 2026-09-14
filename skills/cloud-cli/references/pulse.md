# Pulse CLI

## What Pulse is

Pulse collects metrics, events, and current states from infrastructure, applications, devices, and business processes. It turns that telemetry into a browsable resource inventory, query results, saved queries, and declarative dashboards.

Use `cld pulse` to discover what a Pulse base contains, narrow data to a source or resource, test Query DSL, and build dashboards with Dashboard DSL. Pulse is domain-neutral: the same model works for containers, sales, websites, energy systems, customers, orders, and other observed objects.

## Contents

- [How Pulse organizes data](#how-pulse-organizes-data)
- [Agent workflow](#agent-workflow)
- [Select and inspect a base](#select-and-inspect-a-base)
- [Explore data](#explore-data)
- [Run and save queries](#run-and-save-queries)
- [Build dashboards](#build-dashboards)
- [Manage sources](#manage-sources)
- [Manage access](#manage-access)
- [JSON contracts](#json-contracts)
- [Destructive operations](#destructive-operations)
- [Command reference](#command-reference)
- [Further references](#further-references)

## How Pulse organizes data

Read Pulse data from broad context to specific values:

1. A **base** is a workspace with its own access, retention, sources, saved queries, and dashboards.
2. A **source** is one input connection, such as a Prometheus-compatible endpoint or token-backed HTTP ingest source.
3. A **resource** is an observed object such as a host, container, device, customer, order, or service.
4. A **signal** is a named metric, event, or state.
5. A **variant** is one signal for one source, resource, and dimension set.
6. A **dimension** is an exact-match label such as `region`, `route`, `channel`, `mount`, or `compose_service`.

The UI and query DSL use the same resource model. The `resource` clause selects a complete `type:id` key; `resource_type` selects a class.

Pulse bases, sources, dashboards, and saved queries use immutable six-character IDs in CLI output, APIs, URLs, and Capability refs. Internal database UUIDs are not accepted as public selectors. Observed resources keep their domain `resource_key`; a cross-base resource ref combines the Base ID and resource key as `<base-id>/<resource-key>`. High-volume events, samples, series, state history, scrape runs, and credentials keep technical identities and are not promoted to short-ID resources. See [Public resource identifiers](/en/docs/data/public-resource-identifiers).

- A **metric** is a numeric sample over time, such as memory usage or sales volume.
- An **event** is something that happened at a point in time, such as a deployment or completed order.
- A **state** is the latest known value of a fact, such as online status or current version.

Repeated signal names usually represent variants, not duplicates. For example, `docker.container.cpu.usage` can have one variant per container. Metric queries aggregate each variant independently, then combine variants with `reduce` (default `avg`) and optionally split output with `group by resource` or `group by <dimension>`.

Events separate fields by role:

- `dimensions` are bounded, exact-match fields used by `where` and `group by`.
- `attributes` hold irregular or unique details such as full URLs, request IDs, and user-agent details.
- `sensitive` holds classified JSON such as raw IP or precise geodata. Normal event results never return it, and Pulse clears it on the base's shorter sensitive-retention schedule.
- `payload` holds event-specific JSON that should be returned with an individual event but does not need field discovery.
- `actorId`, `sessionId`, and `correlationId` are first-class event identities. Query DSL can count unique actors and sessions without turning them into dimensions.

Keep metric dimensions bounded. Pulse allows at most 10,000 variants for one metric in one base; use events for unique identities or values. Resources are stable observed objects such as a campaign, link, host, or service, not one resource per visit, session, request, or IP address.

## Agent workflow

Do not start by guessing signal names or generating a large dashboard. Discover the live base first, clarify the question, then build in verified layers.

### 1. Discover the workspace

```bash
cld pulse list --json
cld pulse use "Operations"
cld pulse current
cld pulse overview --json
```

`overview` is the compact planning command. It returns the base, summary counts, sources, dashboards, top resources, and top metrics. Add `--include-inventory` only when the complete inventory is required.

### 2. Inspect the available data

```bash
cld pulse sources list --json
cld pulse resources list --limit 100 --json
cld pulse metrics --limit 100 --json
cld pulse events --limit 100 --json
cld pulse states --limit 100 --json
cld pulse fields list --scope event --limit 100 --json
```

Start with Sources when data may be missing. Start with Resources when the user names an object. Start with Metrics, Events, or States when the signal name is already known.

### 3. Narrow to the subject

```bash
cld pulse resources list --type container --source Docker --json
cld pulse resources get "container:app-core" --json
cld pulse resources metrics "container:app-core" --json
cld pulse resources states "container:app-core" --json
cld pulse resources events "container:app-core" --limit 50 --json
```

Use IDs from JSON output when names are ambiguous. Source filters accept `--source <name-or-id>` or `--source-id <source-id>`, but not both.

### 4. Agree on the intended view

Before creating a dashboard, summarize the observed data and resolve decisions that affect its meaning:

- Which resources or business objects matter?
- Which time range should be the default?
- Does the user need current values, trends, event rows, or state tables?
- Which dimensions distinguish variants?
- Which thresholds should be warning or critical?
- Should the dashboard stay private or have a public display URL?

Do not infer warning thresholds from metric names alone.

### 5. Prove each query

```bash
cld pulse query compile \
  --query 'metric system.memory.usage avg every 5m since 24h resource host:macbook' \
  --json

cld pulse query run \
  --query 'metric system.memory.usage avg every 5m since 24h resource host:macbook' \
  --json
```

Run every query planned for a widget. If a metric matches too many variants, add `source`, `resource`, `resource_type`, or `where` filters.

### 6. Build and verify the dashboard

```bash
cld pulse dashboards compile --file dashboard.pulse --json
cld pulse dashboards create --name "MacBook health" --file dashboard.pulse --refresh 5 --json
cld pulse dashboards snapshot "MacBook health" --json
```

Compile before saving, then inspect a private snapshot before publishing. Keep descriptions near charts that require interpretation.

## Select and inspect a base

Most commands accept a base ID or exact name as a positional argument or as `--base <id-or-exact-name>`. After `use`, omit the base from later commands.

```bash
cld pulse list --json
cld pulse create "Operations" --description "Production telemetry" --use
cld pulse current
cld pulse get --json
cld pulse update \
  --raw-retention-days 30 \
  --rollup-retention-days 365 \
  --sensitive-retention-hours 24
```

Use a separate base when access, retention, ownership, or reporting context should differ. A base is not tied to one technical domain.

Raw retention controls how long detailed metrics, events, and state changes remain available. Rollup retention controls how long long-range metric summaries remain available. Sensitive retention clears only the `sensitive` object from older events; the non-sensitive event remains until raw retention expires.

`capabilities` reports which optional long-range query features are available on the selected Cloud instance:

```bash
cld pulse capabilities --json
```

Capability output is informational and does not change the selected base or Cloud instance.

## Explore data

### Inventory and resources

```bash
cld pulse inventory --json
cld pulse overview --json
cld pulse resources list --q checkout --type service --limit 100 --json
cld pulse resources get "service:checkout" --json
cld pulse resources metrics "service:checkout" --type counter --json
cld pulse resources states "service:checkout" --key service.online --json
cld pulse resources events "service:checkout" --kind deploy.finished --limit 50 --json
```

`inventory` returns the current resource and signal inventory. `overview` is better for initial planning because it also includes sources, dashboards, and ranked resources and metrics.

Resource commands resolve an exact resource key, ID, or label. Filters include:

- `--q <text>` for server-side search.
- `--type <resource-type>` on `resources list`.
- `--source <name-or-id>` or `--source-id <source-id>`.
- `--limit <1-500>` and `--offset <number>`.

### Signals and variants

```bash
cld pulse metrics --q memory --type gauge --resource-type host --json
cld pulse series system.memory.usage --resource host:macbook --json
cld pulse events --kind deploy.finished --resource-type service --limit 100 --json
cld pulse states --key service.online --resource service:checkout --json
```

The signal commands support source and resource scoping:

- `metrics`: `--q`, `--type`, `--resource`, `--resource-type`, source filters, and pagination.
- `series <metric>`: `--q`, `--resource`, `--resource-type`, source filters, and pagination.
- `events`: `--q`, `--kind`, `--resource`, `--resource-type`, source filters, and pagination.
- `states`: `--q`, `--key`, `--resource`, `--resource-type`, source filters, and pagination.

Use `series` to inspect a metric's variants when it has several resources or dimension sets. Use a resource command when the question starts from an observed object.

The `--resource` flag resolves an observed resource before reading its signals. `--resource-type` filters the base-wide signal endpoint.

### Observed fields

Use the field catalog to discover which dimensions, attributes, and sensitive field names a signal has published:

```bash
cld pulse fields list --scope event --role dimension --q page.viewed --json
cld pulse fields list --scope event --role attribute --source "Web analytics" --json
cld pulse fields list --scope event --role sensitive --limit 100 --json
```

The catalog returns field names, roles, observed value types, observation counts, source IDs, and first/last-seen timestamps. It never stores or returns field values. Payload keys and first-class actor, session, and correlation identities are not catalog fields.

Use discovered dimensions with Query DSL `where` and summarized-event `group by`. Attributes and sensitive fields are visible for field inspection but are not Query DSL filters. `--scope` accepts `metric`, `event`, or `state`; `--role` accepts `dimension`, `attribute`, or `sensitive`.

## Run and save queries

Query input accepts `--query`, `--file`/`-f`, or `--stdin`.

```bash
cld pulse query compile --query 'metric http_requests_total rate every 1m since 1h' --json
cld pulse query run --file request-rate.pulse --json
cat request-rate.pulse | cld pulse query save --name "Request rate" --stdin --json
cld pulse query list --json
```

`query compile` returns diagnostics and the compiled query without reading telemetry. `query run` returns exactly one populated result collection: `points`, `events`, or `states`.

Use `reduce sum` for totals across metric variants and `group by resource` for one series per browsable resource:

```bash
cld pulse query run \
  --query 'metric docker.container.network.rx rate every 5m reduce sum group by resource since 24h' \
  --json
```

```bash
cld pulse query save --name "Checkout errors" \
  --description "Critical checkout events" \
  --query 'events checkout.error since 24h where severity=critical limit 100' \
  --json

cld pulse query delete "Checkout errors" --yes
```

`query save` compiles first and rejects invalid input. There is currently no saved-query update command; delete and recreate the saved query when its definition must change.

Read [Pulse Query DSL](pulse-query-dsl.md) for the complete grammar, defaults, aggregations, limits, quoting, and result semantics.

## Build dashboards

Dashboard DSL is the only dashboard authoring format. The saved dashboard name comes from `--name`; the quoted root title in the DSL is part of the document and should normally match it. Numeric widgets accept metric queries and summarized event queries; tables accept event rows and states.

```bash
cld pulse dashboards compile --file operations.pulse --json
cld pulse dashboards create --name "Operations" --file operations.pulse --refresh 5 --json
cld pulse dashboards get "Operations" --json
cld pulse dashboards snapshot "Operations" --json
cld pulse dashboards update "Operations" --file operations-v2.pulse --refresh 10 --json
```

`dashboards compile` returns line-and-column diagnostics without saving. Create and DSL-bearing update compile before writing. `snapshot` executes the private dashboard and returns its public-safe dashboard shape plus point, event, state, and map data without publishing it.

`--refresh` accepts `1`, `5`, `10`, `60`, or `never`. New dashboards default to five-second refresh. Updating DSL preserves the dashboard's current refresh setting unless `--refresh` is supplied.

### Public displays

Publishing creates an unauthenticated link. Treat its token and URL as sharing credentials.

```bash
cld pulse dashboards public-url "Operations" --theme dark --height full --yes
cld pulse dashboards publish "Operations" --theme light --height scroll --yes --json
cld pulse dashboards unpublish "Operations"
```

`--theme` accepts `light` or `dark`. `--height` accepts `scroll` or `full`. These flags change the returned display URL, not the stored dashboard.

`public-url` and `publish` require `--yes` because they enable or reveal a public link. Creating a dashboard with `--public` also requires `--yes`. `unpublish` disables the current link.

Public snapshots expose the rendered layout and widget-bound values. They omit Dashboard DSL, query text, source IDs, and dimensions from returned events and states. This limits accidental exposure but does not make a public link private.

Read [Pulse Dashboard DSL](pulse-dashboard-dsl.md) for the complete authoring language, layout rules, controls, widget compatibility, conditions, and public-display behavior.

## Manage sources

Pulse has three source kinds:

- `metrics`: Pulse scrapes a Prometheus-compatible endpoint. `--endpoint-url` is required; bearer auth and scrape interval are optional.
- `http_ingest`: external collectors push metrics, events, and states with labeled source tokens.

```bash
cld pulse sources create --name "API metrics" --kind metrics \
  --endpoint-url https://api.example.com/metrics \
  --bearer-token-file /secure/path/api-metrics.token \
  --scrape-interval-seconds 60

cld pulse sources create --name "Warehouse importer" --kind http_ingest
cld pulse sources list --json
```

Bearer tokens for scraped endpoints are stored encrypted and are not returned by list output. Pass them through `--bearer-token-file` or `--bearer-token-stdin`; Pulse intentionally rejects inline `--bearer-token` values so secrets do not enter shell history.

```bash
cld pulse sources update "API metrics" --enabled false
cld pulse sources update "API metrics" --clear-bearer-token
cld pulse sources scrape "API metrics" --json
cld pulse sources scrapes "API metrics" --json
```

`sources scrape` applies only to `metrics` sources. `sources scrapes` shows recent success, finish time, ingested counts, duration, and errors.

Create a separate labeled credential for each importer, server, or job. The raw token is returned only when created:

```bash
cld pulse source-tokens create "Warehouse importer" --name production-job --json
cld pulse source-tokens list "Warehouse importer" --json
cld pulse source-tokens revoke "Warehouse importer" production-job --yes
```

`--expires-at` accepts an ISO datetime. Store the returned token in the collector's secret store; do not place it in dashboard DSL, saved queries, shell history, or documentation.

`cld pulse ingest --source <source>` sends a batch through the signed-in user's authenticated API access into that enabled source. External collectors use `/api/pulse/ingest` with a source token instead.

Read [Pulse ingest](pulse-ingest.md) for the complete batch schema, collector request, source-token behavior, limits, transaction semantics, and idempotent retries.

## Manage access

Base permissions are `read`, `write`, and `admin`.

```bash
cld pulse access list --json
cld pulse access search-principals "Sysadmins" --kind group --json
cld pulse access set --group "Sysadmins" --permission write
cld pulse access revoke --group "Sysadmins" --yes
```

Use exactly one principal selector: `--user`, `--group`, or `--authenticated`. Grant, set, and revoke do not accept public or service-account selectors. `access list` returns direct grants and does not expand inherited access; add `--include-service-accounts` when resource-bound service-account entries are needed.

`access grant` creates a direct grant and fails if it already exists. Prefer `access set` for agent workflows because it updates an existing direct grant or creates one when absent. Revocation requires `--yes`; `--access-id` from `access list` can replace principal resolution.

## JSON contracts

Use `--json` whenever another command or agent consumes one complete result. Use `--jsonl` for list commands when the consumer should process one returned item per line. Commands that return a single object or mutation result emit one JSON object line in JSONL mode. The following JSON shapes are abridged: omitted fields remain available in actual output.

### Base and lifecycle

```json
{
  "id": "Base01",
  "name": "Operations",
  "description": "Production telemetry",
  "rawRetentionDays": 30,
  "rollupRetentionDays": 365,
  "sensitiveRetentionHours": 24,
  "deletionStartedAt": null,
  "deletionFailedAt": null,
  "deletionError": null,
  "dataClearStartedAt": null,
  "dataClearCompletedAt": null,
  "dataClearFailedAt": null,
  "dataClearError": null
}
```

`overview --json` returns a compact planning envelope:

```json
{
  "base": { "id": "Base01", "name": "Operations" },
  "summary": {
    "base": "Operations",
    "sources": 2,
    "resources": 42,
    "resourceTypes": 4,
    "metrics": 80,
    "metricSeries": 240,
    "events": 12,
    "states": 96
  },
  "sources": [],
  "dashboards": [],
  "topResources": [],
  "topMetrics": []
}
```

With `--include-inventory`, the same object additionally contains `inventory` and `metrics`.

### Source

```json
{
  "id": "Src001",
  "baseId": "Base01",
  "kind": "http_ingest",
  "name": "Warehouse importer",
  "enabled": true,
  "endpointUrl": null,
  "bearerTokenConfigured": false,
  "scrapeIntervalSeconds": null,
  "lastSeenAt": "2026-07-12T12:00:00.000Z",
  "lastError": null,
  "lastErrorAt": null
}
```

### Resource and metric variant

```json
{
  "key": "container:app-core",
  "id": "app-core",
  "label": "app-core",
  "type": "container",
  "sourceIds": ["Src001"],
  "metricCount": 12,
  "stateCount": 8,
  "eventCount": 2,
  "dimensions": { "compose_service": "app-core" }
}
```

```json
{
  "id": "series-uuid",
  "metric": "docker.container.cpu.usage",
  "sourceId": "Src001",
  "resourceKey": "container:app-core",
  "resourceType": "container",
  "dimensions": { "compose_service": "app-core" },
  "latestValue": 12.4,
  "latestSampleAt": "2026-07-12T12:00:00.000Z"
}
```

### Observed field

```json
{
  "sourceId": "Src001",
  "scope": "event",
  "signalName": "page.viewed",
  "role": "attribute",
  "key": "request_id",
  "valueType": "string",
  "observedCount": 1524,
  "firstSeenAt": "2026-07-12T12:00:00.000Z",
  "lastSeenAt": "2026-07-14T08:30:00.000Z"
}
```

### Query compile and run

```json
{
  "ok": true,
  "diagnostics": [],
  "compiled": {
    "kind": "metric",
    "metric": "system.memory.usage",
    "aggregation": "avg",
    "bucket": "5m",
    "since": "24h"
  }
}
```

```json
{
  "compiled": { "kind": "metric" },
  "points": [{ "bucket": "2026-07-12T12:00:00.000Z", "value": 61.2 }],
  "events": [],
  "states": []
}
```

Individual event rows include `id`, `kind`, `ts`, `value`, `sourceId`, `resourceKey`, `resourceType`, `dimensions`, `attributes`, `payload`, and `recordedAt`. They intentionally omit `sensitive`, `actorId`, `sessionId`, and `correlationId`; summarized queries can still count unique actors and sessions. State rows include a stable `variantKey`, `key`, `value`, `sourceId`, `resourceKey`, `resourceType`, `dimensions`, and `updatedAt`.

### Dashboard snapshot

```json
{
  "dashboard": {
    "id": "Dash01",
    "name": "Operations",
    "config": { "layout": {}, "refreshIntervalSeconds": 5 }
  },
  "points": { "widget-id": [{ "bucket": "2026-07-12T12:00:00.000Z", "value": 61.2 }] },
  "events": { "widget-id": [] },
  "states": { "widget-id": [] },
  "maps": { "widget-id": [] }
}
```

### One-time credentials

`source-tokens create --json` returns metadata and the only copy of the raw token:

```json
{
  "credential": {
    "id": "credential-uuid",
    "name": "production-job",
    "tokenPrefix": "cld_...",
    "permission": "write",
    "expiresAt": null
  },
  "token": "raw-secret-returned-once"
}
```

Agent rules:

- Resolve exact names or IDs before mutation; prefer IDs when names are ambiguous.
- Do not parse human tables.
- Use `--file` or `--stdin` for Query DSL, Dashboard DSL, and ingest JSON.
- Do not echo source or public-display tokens unless the requested workflow requires the value.
- Do not use `--include-inventory` by default.
- Use `--limit` and `--offset` for bounded exploration.

## Destructive operations

Read the target first and act only after explicit user approval.

These commands require `--yes`:

- `delete`: queues deletion of a base and all its contents.
- `clear-data`: queues deletion of telemetry while preserving the base, settings, sources, dashboards, saved queries, and access.
- `sources delete`: deletes a source and invalidates its source-bound credentials.
- `source-tokens revoke`: revokes an ingest credential.
- `query delete`: deletes a saved query.
- `dashboards delete`: deletes a dashboard.
- `dashboards create --public`: creates a dashboard and enables a public link.
- `dashboards publish`: enables or reveals a public link.
- `dashboards public-url`: enables or reveals a public link.
- `access revoke`: removes a direct grant.

Base deletion and data clearing are asynchronous background jobs. `delete` returns once deletion has started and the base disappears from normal list/get operations immediately; the CLI currently has no deletion-status command. `clear-data` can be monitored with `cld pulse get <base-id> --json`: check `dataClearCompletedAt`, `dataClearFailedAt`, and `dataClearError` before treating it as complete.

Deleting a source makes its source-bound credentials unusable and removes source metadata. Historical metric, event, and state rows are retained and their source association becomes null. Use `clear-data` when the intent is to remove telemetry.

`dashboards unpublish` disables public access and needs no confirmation.

## Command reference

Run `cld pulse <command> --help` before using unfamiliar flags or positional arguments.

| Area | Commands |
| --- | --- |
| Deployment | `capabilities` |
| Bases | `list`, `use`, `current`, `get`, `create`, `update`, `delete`, `clear-data` |
| Planning | `overview`, `inventory` |
| Field catalog | `fields list` |
| Resources | `resources list`, `resources get`, `resources metrics`, `resources states`, `resources events` |
| Signals | `metrics`, `series`, `events`, `states` |
| Sources | `sources list`, `sources create`, `sources update`, `sources delete`, `sources scrape`, `sources scrapes` |
| Ingest credentials | `source-tokens list`, `source-tokens create`, `source-tokens revoke` |
| Ingest | `ingest` |
| Queries | `query compile`, `query run`, `query list`, `query save`, `query delete` |
| Dashboards | `dashboards list`, `dashboards get`, `dashboards snapshot`, `dashboards compile`, `dashboards create`, `dashboards update`, `dashboards delete`, `dashboards publish`, `dashboards public-url`, `dashboards unpublish` |
| Access | `access list`, `access grant`, `access set`, `access revoke`, `access search-principals` |

### Canonical command forms

`[base]` means an optional base ID or exact name. Omit it after `cld pulse use`; `--base <base>` is an equivalent explicit selector.

Bases and planning:

```text
cld pulse capabilities
cld pulse list
cld pulse use <base>
cld pulse current
cld pulse get [base]
cld pulse create <name> [--description <text>] [--use]
cld pulse update [base] [--name <name>] [--description <text>]
  [--raw-retention-days <1-3650>] [--rollup-retention-days <1-3650>]
  [--sensitive-retention-hours <1-8760>]
cld pulse delete [base] --yes
cld pulse clear-data [base] --yes
cld pulse overview [base] [--include-inventory]
cld pulse inventory [base]
cld pulse fields list [base] [--q <text>] [--scope <metric|event|state>]
  [--role <dimension|attribute|sensitive>] [source filter] [--limit <1-500>]
```

Resources and signals:

```text
cld pulse resources list [base] [--q <text>] [--type <type>] [source filter] [page]
cld pulse resources get [base] <resource>
cld pulse resources metrics [base] <resource> [--q <text>] [--type <metric-type>] [source filter] [page]
cld pulse resources states [base] <resource> [--q <text>] [--key <key>] [source filter] [page]
cld pulse resources events [base] <resource> [--q <text>] [--kind <kind>] [source filter] [page]

cld pulse metrics [base] [--q <text>] [--type <metric-type>] [resource filter] [source filter] [page]
cld pulse series [base] <metric> [--q <text>] [resource filter] [source filter] [page]
cld pulse events [base] [--q <text>] [--kind <kind>] [resource filter] [source filter] [page]
cld pulse states [base] [--q <text>] [--key <key>] [resource filter] [source filter] [page]
```

Reusable filter groups:

```text
source filter   = [--source <name-or-id> | --source-id <source-id>]
resource filter = [--resource <key-or-id-or-label>] [--resource-type <type>]
page            = [--limit <1-500>] [--offset <non-negative>]
```

Sources and ingest:

```text
cld pulse sources list [base]
cld pulse sources create [base] --name <name> --kind <metrics|http_ingest>
  [--endpoint-url <url>] [--bearer-token-file <path> | --bearer-token-stdin]
  [--scrape-interval-seconds <seconds>]
cld pulse sources update [base] <source>
  [--name <name>] [--enabled <true|false>] [--endpoint-url <url>]
  [--bearer-token-file <path> | --bearer-token-stdin | --clear-bearer-token]
  [--scrape-interval-seconds <seconds>]
cld pulse sources delete [base] <source> --yes
cld pulse sources scrape [base] <source>
cld pulse sources scrapes [base] <source>

cld pulse source-tokens list [base] <source>
cld pulse source-tokens create [base] <source> --name <label> [--expires-at <ISO-datetime>]
cld pulse source-tokens revoke [base] <source> <token-id-or-name-or-prefix> --yes
cld pulse ingest [base] --source <source> (--batch <json> | --file <path> | --stdin)
```

`metrics` sources require `--endpoint-url`. Scraping and scrape history apply only to metrics sources. Token commands apply only to HTTP ingest sources.

Queries:

```text
cld pulse query compile [base] (--query <query> | --file <path> | --stdin)
cld pulse query run [base] (--query <query> | --file <path> | --stdin)
cld pulse query list [base]
cld pulse query save [base] --name <name> [--description <text>]
  (--query <query> | --file <path> | --stdin)
cld pulse query delete [base] <saved-query> --yes
```

Dashboards:

```text
cld pulse dashboards list [base]
cld pulse dashboards get [base] <dashboard>
cld pulse dashboards snapshot [base] <dashboard>
cld pulse dashboards compile [base] (--content <dsl> | --file <path> | --stdin)
cld pulse dashboards create [base] --name <name> (--content <dsl> | --file <path> | --stdin)
  [--refresh <1|5|10|60|never>]
  [--public --yes] [--theme <light|dark>] [--height <scroll|full>]
cld pulse dashboards update [base] <dashboard>
  [--name <name>] [--content <dsl> | --file <path> | --stdin]
  [--refresh <1|5|10|60|never>]
cld pulse dashboards delete [base] <dashboard> --yes
cld pulse dashboards publish [base] <dashboard> [--theme <light|dark>] [--height <scroll|full>] --yes
cld pulse dashboards public-url [base] <dashboard> [--theme <light|dark>] [--height <scroll|full>] --yes
cld pulse dashboards unpublish [base] <dashboard>
```

Access:

```text
cld pulse access list [base] [--include-service-accounts]
cld pulse access search-principals <query> [--kind <user,group>] [--page <n>] [--per-page <n>]
cld pulse access grant [base] <one principal selector> --permission <read|write|admin>
cld pulse access set [base] (<one principal selector> | --access-id <id>) --permission <read|write|admin>
cld pulse access revoke [base] (<one principal selector> | --access-id <id>) --yes

principal selector = --user <ref> | --group <ref> | --authenticated
```

## Further references

- [Pulse Query DSL](pulse-query-dsl.md) is the complete query grammar and execution reference.
- [Pulse Dashboard DSL](pulse-dashboard-dsl.md) is the complete dashboard authoring reference.
- [Pulse ingest](pulse-ingest.md) is the complete collector and batch contract.

### Absolute analytics periods

Query text supports either `since` or `from <ISO timestamp> to <ISO timestamp>`.
Absolute timestamps require UTC or an offset; the interval includes its start
and excludes its end. Event aggregates accept `every all` for period totals, or
`every day|week|month timezone <IANA zone>` for calendar boundaries. Unique actor
and session IDs are source-local; missing identities do not count.

```bash
cld pulse query run --query 'events page.viewed unique actor every all from 2026-09-01T00:00:00+02:00 to 2026-10-01T00:00:00+02:00' --json
cld pulse query run --query 'events page.viewed count every day timezone Europe/Berlin since 7d group by route' --json
```

Use one HTTP ingest source per website. Website backends send unchanged retry
batches with the same idempotency key to `/api/pulse/ingest`; keys are retained
for 24 hours. Keep source tokens out of browser code.
