# Pulse CLI

## What Pulse is

Pulse collects metrics, events, and current states from infrastructure, applications, devices, and business processes. Sources show connection health and recent collection results.

Use `cld pulse` to manage bases, access, sources, source tokens, and ingest. Pulse is domain-neutral: the same model works for containers, sales, websites, energy systems, customers, orders, and other observed objects.

## Contents

- [Connect the data store (Cloud admins)](admin.md)

- [How Pulse organizes data](#how-pulse-organizes-data)
- [Select and inspect a base](#select-and-inspect-a-base)
- [Manage sources](#manage-sources)
- [Manage access](#manage-access)
- [JSON contracts](#json-contracts)
- [Destructive operations](#destructive-operations)
- [Command reference](#command-reference)
- [Further references](#further-references)

## How Pulse organizes data

Pulse organizes incoming data by base and source:

1. A **base** is a workspace with its own access, retention, and sources.
2. A **source** is one input connection, such as a Prometheus-compatible endpoint or token-backed HTTP ingest source.
3. A **resource** is an observed object such as a host, container, device, customer, order, or service.
4. A **signal** is a named metric, event, or state.
5. A **variant** is one signal for one source, resource, and dimension set.
6. A **dimension** is an exact-match label such as `region`, `route`, `channel`, `mount`, or `compose_service`.

Pulse bases and sources use immutable six-character IDs in CLI output, APIs, URLs, and Capability refs. Internal database UUIDs are not accepted as public selectors.

- A **metric** is a numeric sample over time, such as memory usage or sales volume.
- An **event** is something that happened at a point in time, such as a deployment or completed order.
- A **state** is the latest known value of a fact, such as online status or current version.

Events separate fields by role:

- `dimensions` are bounded labels.
- `attributes` hold irregular or unique details such as full URLs, request IDs, and user-agent details.
- `sensitive` holds classified JSON such as raw IP or precise geodata. Pulse clears it on the base's shorter sensitive-retention schedule.
- `payload` holds nested event-specific JSON.
- `actorId`, `sessionId`, and `correlationId` are event identities; keep them out of dimensions.

Keep metric dimensions bounded. Pulse allows at most 10,000 variants for one metric in one base; use events for unique identities or values. Resources are stable observed objects such as a campaign, link, host, or service, not one resource per visit, session, request, or IP address.

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

Shortening retention first prints a preview with the retention kind, new duration
(days for raw and rollup, hours for sensitive), cutoff, rows, and bytes, then
fails without changing the base. Review it and rerun the same update with
`--confirm-shorter-retention` to allow removal. The CLI never confirms automatically.
Use `--json` for a structured preview.

Use a separate base when access, retention, ownership, or reporting context should differ. A base is not tied to one technical domain.

Raw retention controls how long detailed metrics, events, and state changes remain available. Rollup retention controls how long long-range metric summaries remain available. Sensitive retention clears only the `sensitive` object from older events; the non-sensitive event remains until raw retention expires.



Capability output is informational and does not change the selected base or Cloud instance.

## Manage sources

Pulse has two source kinds:

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

Create a separate labeled credential for each importer, server, or job. The token is written only to a new private file:

```bash
cld pulse source-tokens create "Warehouse importer" --name production-job --output-file ./pulse.token --json
cld pulse source-tokens list "Warehouse importer" --json
cld pulse source-tokens revoke "Warehouse importer" production-job --yes
```

`--expires-at` accepts an ISO datetime. Store the returned token in the collector's secret store; do not place it in shell history or documentation.

`cld pulse ingest --source <source>` sends a batch through the signed-in user's authenticated API access into that enabled source. External collectors use `/api/pulse/ingest` with a source token instead.

Read [Pulse ingest](ingest.md) for the complete batch schema, collector request, source-token behavior, limits, transaction semantics, and idempotent retries.

## Manage access

Base permissions are `read`, `write`, and `admin`.

```bash
cld pulse access list --json
cld pulse access search-principals "Sysadmins" --kind group --json
cld pulse access set --group "Sysadmins" --permission write
cld pulse access revoke --group "Sysadmins" --yes
```

Use exactly one principal selector: `--user`, `--group`, `--service-account`, or `--authenticated`. Grant, set, and revoke do not accept a public selector. `--service-account` takes a service account ID or exact name; `search-principals --kind service_account` finds standalone and agent accounts by name. `access list` returns direct grants, including agent grants, and does not expand inherited access; add `--include-service-accounts` when the grants behind resource-bound tokens are needed.

An agent account works like a person with the same grant: it lists and reads the bases it was granted and changes them with a `write` grant. Its token's scopes cap the grant, so a `read`-only token cannot write even with a `write` grant; managing access, deleting, or clearing a base needs an `admin` grant and a token with the `admin` scope. Creating bases and managing source tokens stay limited to people.

`access grant` creates a direct grant and fails if it already exists. Prefer `access set` for agent workflows because it updates an existing direct grant or creates one when absent. Revocation requires `--yes`; `--access-id` from `access list` can replace principal resolution.

## JSON contracts

Base and source objects in JSON/JSONL output carry `permalink`, an absolute Cloud link to share with the person; never build Cloud URLs yourself.

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
  "metricFilters": [],
  "status": {
    "newestDataAt": "2026-07-12T12:00:00.000Z",
    "throttled": false,
    "throttledAt": null,
    "refusedHistograms": [],
    "skippedSummaries": 0,
    "lastError": null,
    "lastErrorAt": null
  }
}
```

### One-time credentials

`source-tokens create` requires `--output-file`. It writes the raw token with
mode 0600 and refuses an existing path. Text, JSON and JSONL output contain
only the token ID, name and file path:

```json
{
  "id": "credential-uuid",
  "name": "production-job",
  "path": "/private/pulse.token"
}
```

Agent rules:

- Resolve exact names or IDs before mutation; prefer IDs when names are ambiguous.
- Do not parse human tables.
- Use `--file` or `--stdin` for ingest JSON.
- Keep source tokens in the private output file or move them into the collector’s secret store. Never echo them.

## Destructive operations

Read the target first and act only after explicit user approval.

These commands require `--yes`:

- `delete`: queues deletion of a base and all its contents.
- `clear-data`: queues deletion of telemetry while preserving the base, settings, sources, and access.
- `sources delete`: deletes a source and invalidates its source-bound credentials.
- `source-tokens revoke`: revokes an ingest credential.
- `access revoke`: removes a direct grant.

Base deletion and data clearing are asynchronous background jobs. `delete` returns once deletion has started and the base disappears from normal list/get operations immediately; the CLI currently has no deletion-status command. `clear-data` can be monitored with `cld pulse get <base-id> --json`: check `dataClearCompletedAt`, `dataClearFailedAt`, and `dataClearError` before treating it as complete.

Deleting a source makes its source-bound credentials unusable and removes source metadata. Historical metric, event, and state rows are retained and their source association becomes null. Use `clear-data` when the intent is to remove telemetry.

## Command reference

Run `cld pulse <command> --help` before using unfamiliar flags or positional arguments.

| Area | Commands |
| --- | --- |
| Bases | `list`, `use`, `current`, `get`, `create`, `update`, `delete`, `clear-data` |
| Sources | `sources list`, `sources create`, `sources update`, `sources delete`, `sources scrape`, `sources scrapes` |
| Ingest credentials | `source-tokens list`, `source-tokens create`, `source-tokens revoke` |
| Ingest | `ingest` |
| Access | `access list`, `access grant`, `access set`, `access revoke`, `access search-principals` |

### Canonical command forms

`[base]` means an optional base ID or exact name. Omit it after `cld pulse use`; `--base <base>` is an equivalent explicit selector.

Bases:

```text
cld pulse list
cld pulse use <base>
cld pulse current
cld pulse get [base]
cld pulse create <name> [--description <text>] [--use]
cld pulse update [base] [--name <name>] [--description <text>]
  [--raw-retention-days <1-3650>] [--rollup-retention-days <1-3650>]
  [--sensitive-retention-hours <1-8760>] [--confirm-shorter-retention]
cld pulse delete [base] --yes
cld pulse clear-data [base] --yes
```

Sources and ingest:

```text
cld pulse sources list [base]
cld pulse sources create [base] --name <name> --kind <metrics|http_ingest>
  [--endpoint-url <url>] [--bearer-token-file <path> | --bearer-token-stdin]
  [--scrape-interval-seconds <seconds>] [--metric-filter <family-or-prefix> ... | --clear-metric-filters] [--metric-filter <family-or-prefix> ...]
cld pulse sources update [base] <source>
  [--name <name>] [--enabled <true|false>] [--endpoint-url <url>]
  [--bearer-token-file <path> | --bearer-token-stdin | --clear-bearer-token]
  [--scrape-interval-seconds <seconds>]
cld pulse sources delete [base] <source> --yes
cld pulse sources scrape [base] <source>
cld pulse sources scrapes [base] <source>

cld pulse source-tokens list [base] <source>
cld pulse source-tokens create [base] <source> --name <label> --output-file <path> [--expires-at <ISO-datetime>]
cld pulse source-tokens revoke [base] <source> <token-id-or-name-or-prefix> --yes
cld pulse ingest [base] --source <source> (--batch <json> | --file <path> | --stdin)
```

`metrics` sources require `--endpoint-url`. Scraping and scrape history apply only to metrics sources. Token commands apply only to HTTP ingest sources.

Access:

```text
cld pulse access list [base] [--include-service-accounts]
cld pulse access search-principals <query> [--kind <user,group,service_account>] [--page <n>] [--per-page <n>]
cld pulse access grant [base] <one principal selector> --permission <read|write|admin>
cld pulse access set [base] (<one principal selector> | --access-id <id>) --permission <read|write|admin>
cld pulse access revoke [base] (<one principal selector> | --access-id <id>) --yes

principal selector = --user <ref> | --group <ref> | --service-account <ref> | --authenticated
```

## Further references

- [Pulse ingest](ingest.md) is the complete collector and batch contract.
