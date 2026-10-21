# Pulse CLI

Pulse collects metrics, events, and states in bases. Use `cld pulse` to inspect
bases and source health, configure sources and access, and ingest batches.
Read one base with `cld pulse sql` or the `sql.run` capability. Save reusable
SQL with `cld pulse queries`. Read [SQL and saved queries](sql.md) for parameters,
limits, cancellation, result formats, and exit codes. Use `queries save --pin`
to show a saved number on the base overview (at most four), or `--unpin` to
remove it. Read [Alert rules](alerts.md) for rule CRUD and source expectations.

Read [Ingest](ingest.md) for the batch contract, retries, metric filters, and
scrape limits. Read [Administration](admin.md) for ClickHouse setup, base
policy, limits, recovery, and internal targets.

## Select a base

```sh
cld pulse --help
cld pulse list --json
cld pulse create Operations --description 'Production telemetry' --use
cld pulse current
cld pulse get --json
cld pulse use Base01
```

Base and source IDs have six characters. Use their ID or exact name; internal
UUIDs are not public selectors. Commands with `[base]` accept a positional base
or `--base <id-or-exact-name>`. Omit it after `use` selects a default.

Each base has its own access, retention, and ClickHouse database. By default,
people and agents with write or admin credential scope can create bases and
receive `admin` access. A delegated agent creates for its person. Cloud
administrators can restrict this policy. Source-bound credentials cannot create
bases. Managing source tokens remains limited to people.

`get` includes the base icon, color, and IANA timezone. A base admin can use
`update --icon <icon> --color <color> --timezone Europe/Berlin`. Icons use the
shared `@k2b/ui` picker list. Colors use the shared accent palette:
`zinc`, `blue`, `emerald`, `amber`, and `red`. A new base inherits `app.timezone`.
Its six-character identifier stays read-only.

New bases provision before accepting changes. `get --json` includes the store
state, operation, write-block reason, profile, limits, and measured usage.
Cloud administration shows amounts and state without measurement contents.

## Configure sources and send data

```sh
cld pulse sources create --name importer --kind http_ingest
cld pulse source-tokens create importer --name production --output-file ./pulse.token
cld pulse ingest --source importer --file batch.json
cld pulse sources list --json

cld pulse sources create --name node --kind metrics \
  --endpoint-url https://metrics.example.com/metrics \
  --scrape-interval-seconds 60 --metric-filter 'node_*' --metric-filter up
cld pulse sources scrape node --json
cld pulse sources scrapes node --json
```

`source-tokens create` requires a new `--output-file`, writes mode `0600`, and
prints only ID, name, and path, including in JSON/JSONL. Never print the token
or read it into agent context. Send it from the collector's secret store.

Scrape filters match exact family names or `prefix*`. Repeat `--metric-filter`
on create or update; use `--clear-metric-filters` only on update to include all
families. Excluded families do not consume sample or series limits.

Endpoint bearer credentials use `--bearer-token-file` or
`--bearer-token-stdin`. List output never reveals them. A changed endpoint
origin deletes the stored token unless you supply a replacement.

Source JSON contains `metricFilters` and `status`: newest data time, recent
throttling, refused histogram families, skipped summary samples, and last error
and time. `sources scrapes` adds attempt counts, duration, and success.

CLI ingest uses authenticated base/source access and has no idempotency flag.
For retry-safe collector delivery, use `POST /api/pulse/ingest` with a source
token and an `Idempotency-Key` from the first attempt. See [Ingest](ingest.md)
for reservation, 24-hour lifetime, pending retries, and partial-write failures.

## Change retention and access

```sh
cld pulse update --raw-retention-days 30 --rollup-retention-days 365 --sensitive-retention-hours 24
cld pulse access list --json
cld pulse access search-principals 'Release agent' --kind service_account --json
cld pulse access set --service-account 'Release agent' --permission read
```

Shortening retention first returns a preview with cutoff, rows, and estimated
bytes, then fails without changing settings. Review it and repeat the update
with `--confirm-shorter-retention`. For sensitive retention, rows means
nonempty fields to clear; events remain. Raw retention is also bounded by the
Cloud administrator's policy. Current states do not expire.
Over the API, `PULSE_RETENTION_CONFIRMATION_REQUIRED` carries
`previewedFrom`. Send it back as `expectedRetention` with the confirmation:
if retention changed in the meantime, Pulse answers `409 PULSE_BASE_CHANGED`.
`--confirm-shorter-retention` confirms against the current settings.

Base access levels are `read`, `write`, and `admin`. An agent's effective
access is capped by its credential scopes. Managing access, deleting, or
clearing needs base `admin` access and an `admin` credential scope.

Choose one principal with `--user`, `--group`, `--service-account`, or
`--authenticated`. There is no public selector. `access grant` fails if the
direct entry exists; `access set` creates or updates it. `set` and `revoke`
also accept `--access-id`. Lists show direct entries without expanding inherited
access; add `--include-service-accounts` to include source-bound entries.

## Delete or clear deliberately

Read the exact target and obtain explicit user approval before deletion or
clearing. `delete`, `clear-data`, `sources delete`, `source-tokens revoke`,
and `access revoke` require `--yes`.

`clear-data` discards measurements while preserving the base, settings,
sources, tokens, and access. It runs asynchronously. Inspect `get --json` and
its store state and clear completion/failure fields before treating it as done.
A checkpoint mismatch or missing database blocks clearing until a Cloud
administrator repairs it; see [Administration](admin.md).

`delete` starts asynchronous deletion and revokes source tokens and database
read access. Normal CLI `list` and `get` exclude deleting bases. The Pulse
overview retains them for base administrators, and `admin bases list` includes
them. Failed operations need **Retry** or `admin bases retry`.

Deleting a source invalidates its credentials and removes it from the source
list. Historical measurements remain; source deletion does not clear telemetry.

## Current command forms

Use `cld pulse <command> --help` for exact flags. `--json` gives one structured
response; `--jsonl` emits list items separately. Base and source objects carry
`permalink`; share it instead of constructing a URL.

```text
cld pulse sql --base <id-or-short-id> [--file <path> | - | <sql>] [--param name=value ...]
cld pulse queries list|get|save|delete --base <id-or-short-id>
cld pulse list
cld pulse use <base>
cld pulse current
cld pulse get [base]
cld pulse create <name> [--description <text>] [--use]
cld pulse update [base] [--name <name>] [--description <text>]
  [--icon <icon>] [--color <color>] [--timezone <IANA-zone>]
  [--raw-retention-days <1-3650>] [--rollup-retention-days <1-3650>]
  [--sensitive-retention-hours <1-8760>] [--confirm-shorter-retention]
cld pulse delete [base] --yes
cld pulse clear-data [base] --yes

cld pulse sources list [base]
cld pulse sources create [base] --name <name> --kind <metrics|http_ingest>
  [--endpoint-url <url>] [--bearer-token-file <path> | --bearer-token-stdin]
  [--scrape-interval-seconds <seconds>] [--metric-filter <family-or-prefix> ...]
cld pulse sources update [base] <source>
  [--name <name>] [--enabled <true|false>] [--endpoint-url <url>]
  [--bearer-token-file <path> | --bearer-token-stdin | --clear-bearer-token]
  [--scrape-interval-seconds <seconds>]
  [--metric-filter <family-or-prefix> ... | --clear-metric-filters]
cld pulse sources delete [base] <source> --yes
cld pulse sources scrape [base] <source>
cld pulse sources scrapes [base] <source>

cld pulse source-tokens list [base] <source>
cld pulse source-tokens create [base] <source> --name <label>
  --output-file <path> [--expires-at <ISO-datetime>]
cld pulse source-tokens revoke [base] <source> <token-id-or-name-or-prefix> --yes
cld pulse ingest [base] --source <source> (--batch <json> | --file <path> | --stdin)

cld pulse access list [base] [--include-service-accounts]
cld pulse access search-principals <query> [--kind <user,group,service_account>]
  [--page <n>] [--per-page <n>]
cld pulse access grant [base] <principal> --permission <read|write|admin>
cld pulse access set [base] (<principal> | --access-id <id>) --permission <read|write|admin>
cld pulse access revoke [base] (<principal> | --access-id <id>) --yes
principal = --user <ref> | --group <ref> | --service-account <ref> | --authenticated
```

Metrics sources require an endpoint; scraping applies only to metrics sources.
Source-token commands apply only to HTTP ingest sources. For `admin store`,
`admin policy`, `admin bases`, `admin orphans`, and `admin targets`, use the
[Administration reference](admin.md).
