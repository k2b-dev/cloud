---
title: Pulse
navTitle: Pulse
section: Operations
order: 420
description: Collect telemetry and query each base with read-only SQL.
tags: [pulse, telemetry, metrics]
updated: 2026-10-22
---

# Pulse

Pulse collects metrics, events, and states in bases. Add sources, send batches
through HTTP ingest, or let Pulse scrape Prometheus endpoints. Measurements go
to one ClickHouse database per base; Postgres keeps control data.

Use SQL through the API, CLI, or `sql.run` capability to read measurements.
Saved queries keep SQL and parameters for reuse. The live SQL console is a
separate interface for these same operations. Dashboards save SQL results as
numbers, charts, tables, and funnels.

Cloud administrators open **Administration → App administration → Pulse** to
manage the data store, bases, and internal targets. **Data store** opens first.
Pulse uses the shared app administration list, with no separate sidebar section.

## See what needs attention

The base switcher shows the number of configured members. Each person, group
or agent counts once; general access rules do not count as individual members.

A base opens on **Overview**. It shows source freshness, alert rules needing
attention, up to four saved key numbers, and recent changes. Existing
`/app/pulse/:baseId/sources` links still open the sources view.
The workspace fills the available app height on desktop and phone. Longer
content scrolls inside it; key numbers keep their natural size.
The overview refreshes every 60 seconds while visible. **View** on an alert
opens its authorized SQL and parameter values in the console without running
it. The URL stores the rule reference, so long SQL survives reload and Back.
Number-only updates keep the headline and tiles in place. When attention rows
appear or disappear, the list grows or shrinks naturally and following sections
move with it. An action that remains in the list keeps keyboard focus.

**Ask AI** opens an unsent Assistant draft asking what needs attention in this
base and why. The draft carries the base resource and the Pulse skill. Data
texts remain evidence, never instructions; writing still requires approval.

### Put a saved number on the overview

In SQL's saved list, enable **On overview**, or save with `cld pulse queries
save --pin`. At most four queries can be pinned per base. This needs write
access; `--unpin` removes a pin. API `pinned` is optional: omitting it preserves
an existing pin. Changing a pin uses the saved query's current revision.

The result's first numeric column supplies the value from its last row. The
first `DateTime` or `DateTime64` column supplies sparkline timestamps in result
order. A scalar without a time column remains a valid number without a trend.
Optional String columns in the last row supply `unit` and `detail`.
`detailTone` accepts `neutral`, `success`, `warning`, or `danger`; missing or
unknown tones are neutral. Invalid optional presentation metadata does not
invalidate an otherwise valid number. These columns are text, never HTML or
CSS. A missing or invalid final numeric value is shown as unavailable.

For referenced parameters, Pulse supplies `from` and `to` for the preceding
24 hours, aligned to a five-minute slot, and `bucket` for five minutes. Other
saved parameters are preserved; `base_tz` retains its normal reserved meaning.
There are at most four execution attempts per base in each aligned five-minute
slot, shared across readers and replicas. Edits, pin replacement, cache expiry,
and failed attempts do not refill that slot's budget. These executions use the
overview budget, separate from questions.

A failed refresh keeps the last successful values with their original times.
Store outages show that the values are old; an unavailable value is never
replaced with zero. Removing read access hides the protected overview, including
previously loaded values. `GET /api/pulse/bases/:baseId/overview` has the same
read boundary for people and agents. It returns bounded attention pages using
`attentionLimit`/`attentionOffset` and activity pages using
`activityLimit`/`activityCursor`; the response supplies the next offset/cursor.
Page sizes range from 1 to 1,000. Recent activity identifies the actual person
or service account when recorded; it does not infer an approving person.

## Manage alert rules and source expectations

Use `cld pulse alerts list|get|save|delete`, the alert HTTP routes, or the
`alert.list`, `alert.read`, `alert.save`, and `alert.delete` capabilities.
Reading needs base read access; changes need write access. There is no rule
editor in the UI. **View** opens the rule in the SQL console.

A rule returns `key` and finite numeric `value` columns, with at most 100
unique keys. Configure an `above` or `below` comparison, warning and/or critical
thresholds, a minimum duration, and an interval of at least 300 seconds. A base
starts with a limit of 20 rules. Saving uses an idempotency key and, for an
update, the current revision. A conflict requires rereading the rule.
`alert.save` approval can be remembered; deletion always asks.

Pulse checks due rules and source freshness every minute, independently of open
tabs. Each rule has a ten-second SQL deadline and uses only free execution
slots, without consuming the question quota. A missed check is an error, never
an assumed success. Work is bounded per tick: at most 60 due rules and 2,000
sources; a backlog continues on later ticks.

Starting with this release, alert SQL has a separate budget of 240 admitted
checks per clock hour per base, shared by all replicas. Editing or replacing a rule does not
reset this budget. With all 20 rules running every five minutes, immediate
checks after edits can exhaust the budget before the hour ends. Refused
admission consumes no check; an admitted query that fails still counts. When the budget is exhausted, due checks report an error
and subsequent scheduled checks can resume in the next hour. Interactive SQL
keeps its own hourly quota.

Firing, escalation, missing data, errors, and recovery notify the base's admins
through Cloud; browser and email delivery are recommended and respect their
notification preferences. Pending thresholds do not notify. The state change
and its notification event are committed together, and delivery checks admin
access again. The event stores the installation language (`app.locale`) as
delivery metadata. Browser text, email, and retries use that same language,
even if the installation language changes before delivery. This is the
installation language, not a recipient profile language.

HTTP ingest sources accept either `expectEverySeconds`, `expectDailyBy`
(`HH:MM` in the base timezone), or neither. The UI offers these under
**Edit → Expected data**; the CLI uses `--expect-every`, `--expect-daily-by`,
or `--clear-expectation`. The freshness measure is the newest data timestamp,
not the last contact. It does not certify complete data for a day. Scraped
sources use three configured intervals.

The `source.create` and `source.update` capabilities always ask and expose
neither tokens nor approval fields. Updates use the current source revision.
A lost create response leaves the draft visible with **Check sources** and
blocks another submission until the person checks the canonical source list.

## Connect the data store

The operator provides a dedicated, single-node ClickHouse instance, version
26.9 or newer, with its own volume. A Cloud administrator opens
**Administration → Pulse → Data store**, obtains the setup script, and has the
ClickHouse administrator run it. Enter the service address and credentials,
then choose **Check and connect**. Pulse checks the connection, version, access,
and read profiles before saving; failed checks leave the saved connection unchanged.

Without a connection, Pulse shows **Pulse is not set up yet**. Its data API
returns `503 PULSE_STORE_NOT_CONFIGURED`; setup and other Cloud apps remain
available. See [Provide ClickHouse for Pulse](/en/docs/operations/deployment-requirements#provide-clickhouse-for-pulse)
for setup, sizing, and backups, and [Deprecations and migrations](/en/docs/reference/deprecations-and-migrations#pulse-requires-clickhouse-and-starts-empty)
before updating an existing installation. The full
[Deployment requirements](/en/docs/operations/deployment-requirements) cover
Cloud startup dependencies and readiness checks.

## Bases and administration

Each base is a tenant with its own database, read user, and restricted read
views. Read access excludes internal tables, sensitive fields, payloads, and
other bases. A base administrator controls members, sources, tokens, and
retention without needing the Cloud administrator role. Cloud administrators
set installation policy, profiles, limits, and internal scrape targets; their
administration pages show amounts and state, without measurement contents.

By default, people and agents with write credentials can create a base and
receive its `admin` access. For a delegated agent, that access goes to its
person. Cloud administrators can restrict creation to people or Cloud
administrators and change the default maximum of 200 bases under
**Administration → Pulse → Bases**. Every service account counts as an agent
for this policy, including one acting for a person. Source-bound credentials
cannot create bases.

A new base moves from `provisioning` to `active`. Changes require an active
base. Clearing (`clearing`) discards measurements and keeps sources, tokens,
settings, and access. Deleting (`deleting`) revokes source tokens and database
read access before removing the database. The overview keeps a deleting base
visible to its administrators until deletion finishes. After five failed
attempts the operation is `failed`. A base administrator chooses **Retry** in
the base settings or overview; a Cloud administrator can retry from **Bases**.
Open pages check a running operation every five seconds. If that check fails,
the overview card and the **Bases** row say the status is unknown, keep
checking, and offer **Retry** to check again at once.

| Per-base setting | Default or fixed profile |
| --- | --- |
| Values per minute | 2,000 metrics, events, and states combined |
| Bytes per minute | 5 MiB |
| Storage threshold | 5 GB |
| Metric series | 50,000 across the base; at most 10,000 per metric |
| Event kinds / state keys | 2,000 each |
| Questions and SQL per clock hour | 600; Cloud administrators can change this per base |
| Small read profile | 1 GB memory, 10 seconds |
| Normal read profile | 2 GB memory, 10 seconds |
| Large read profile | 4 GB memory, 30 seconds |
| Result limit for each read profile | 10,000 rows and 4 MiB |

Pulse measures storage and instance free space every five minutes. Base
administrators and Cloud administrators can inspect those amounts.

Hourly checkpoints compare Postgres and ClickHouse. A missing database or a
checkpoint mismatch blocks measurement writes and prevents a base
administrator from clearing data. Restore matching backups, then have a Cloud
administrator choose **Check again**. **Start empty** discards measurements and
recreates an empty base store. At startup, Pulse restores missing read users for matching databases.
Databases with no base appear as orphans and can be deleted separately.

## Query one base with SQL

Read access allows SQL execution and saved-query reads. Write access allows
saving, changing, and deleting queries. Readers can inspect base settings and
usage; only base administrators can change them.
An agent with a read grant has the same query access as a person. To answer a
question across two bases, run two queries with separate base IDs.

Use `POST /api/pulse/bases/:baseId/sql` with `{sql, params?, runId?}`. Base IDs
and short IDs work. SQL can read `samples`, `rollups`, `series`, `events`,
`states`, and `sources`. Internal tables, `sensitive`, `payload`, credentials,
and other bases remain inaccessible. SQL cannot select a different base.
Only `SELECT` and `WITH` statements are accepted. A final semicolon is removed;
multiple statements, top-level `FORMAT` or `SETTINGS`, `INTO OUTFILE`, raw
ClickHouse parameter syntax, and unbalanced SQL are refused before admission.
`#` comments and `$` heredoc syntax are unsupported; use `--` or `/* */`
comments and quoted strings.

Editing SQL or parameter values clears the previous result. A response from a
run started before that edit does not appear under the changed query.

While a request runs, the console shows its elapsed request time. This includes
waiting and transport, not just database execution. Cancel stops the request;
the elapsed-time display stops when the request ends. Failed queries keep the
SQL and parameter values, explain the failure, and offer recovery where possible.

The result contains column names and ClickHouse types, compact row arrays,
`rowCount`, `truncated`, execution statistics, and limits. The wrapper applies
`LIMIT 10000`. Exactly 10,000 returned rows sets `truncated: true`: **the
10,000-row limit was reached; there may be more**. This flag does not prove
that another row exists. Results over 4 MiB fail with `RESULT_TOO_LARGE`.

The console charts the first time column against numeric columns, using up to
8 series and the first 480 rows in returned order. It states when the chart is
cut. The time axis uses the column's time zone, or UTC if none is specified.
The axis labels the two ends of the returned time range, or the sole timestamp
if all points share one. For a single day,
labels show times and the axis names the date; longer ranges show calendar dates. Inspect a point for its full date, time, and UTC offset.
Date-only columns show dates without a time.

### Console URLs and Assistant drafts

The console route is `/app/pulse/:baseId/sql`; a saved query adds its ID or
short ID as the final path segment. An unsaved console keeps SQL and parameter
values in the URL. A saved console keeps its query ID, current SQL, and parameter
values, including unsaved edits. Reload restores that draft; opening a plain
saved-query link loads its saved SQL.

Console links have a 4,000-character budget, including percent-encoding. If
SQL and parameters exceed it, the entire console payload is omitted. The
saved query ID and settings tab remain. The full draft stays in that tab's
browser history entry and is restored after reload, including for readers who
cannot save queries. It is not included when you share or open the link in
another tab. To share a long draft, copy its SQL and parameter values or save
the query if you have write access. Result rows are never stored in URLs or
browser history.

The chart adapter uses the first Date, DateTime, or DateTime64 column as X and
numeric columns as series, including Nullable numeric columns. It takes at
most eight series and the first 480 returned rows, without reordering them.
The cut counts refer to the returned result, not rows beyond the server's
result limit. Missing dates, numbers, or rows have separate no-chart reasons.

**Ask AI** opens an unsent Assistant draft containing the current SQL,
parameter values, and base reference. It loads the `cloud-pulse` Skill and
`sql.run`, `base.read`, and `source.list` tools. Launch failure leaves the SQL
unchanged and can be retried. The hourly SQL quota blocks execution until its
reset time; saving remains available.

### Bind parameters

Write `:name` outside strings, identifiers, and comments. Names are
case-sensitive and match `[A-Za-z_][A-Za-z0-9_]*`. Send values as strings in
`params`; Pulse binds values as data, including quotes and SQL-looking text.
Missing values return `PARAMETER_MISSING`. Unused values and reserved names
are refused. `:base_tz` is reserved: Pulse binds the base's IANA timezone.
New bases inherit the Cloud `app.timezone` setting. A base administrator can
change the timezone, icon, and color. The short ID remains read-only.
Icons use the shared `@k2b/ui` icon picker catalog. Colors use its fixed
accent palette: `zinc`, `blue`, `emerald`, `amber`, or `red`.
The CLI exposes `--icon`, `--color`, and `--timezone` on base updates.

| Value | Binding |
| --- | --- |
| ISO date-time with or without a zone, or `2026-10-20` | `DateTime64(3, '<base timezone>')`; zoned instants keep their offset; zone-free dates and times use the base timezone |
| `30s`, `5m`, `1h`, `1d`, `2w` | `UInt32` seconds |
| Finite number | `Float64` |
| Other text | `String` |

Every path permits at most 16 KiB of UTF-8 SQL, 32 parameters, and 2 KiB of
UTF-8 per value. String values are escaped for ClickHouse's parameter format
before URL encoding, preserving backslashes, control characters and Unicode.
In the worst case these steps expand a value sixfold: 32 × 6 × 2 KiB uses
384 KiB of the client's 512 KiB URL budget. The remaining 128 KiB covers names,
types, database, query ID, and other URL overhead. SQL is sent in the body.

While a query runs, the SQL and parameter fields remain selectable but
read-only. Run changes to Cancel in the same position; the editor shortcut
and Enter in a parameter field also cancel the current run. Saving resumes
when the run settles. A missing parameter stays associated with its visible
diagnosis and focus action even if a save or Assistant launch also fails.

The console shows each active limit separately. Only the affected limit is
highlighted. Results without a chart use the table area directly; time-series
results show a wrapping legend above the plot. Loading shapes preserve known
result geometry and do not imply a row count before a result is available.

### Use time buckets and metric helpers

Use `bucket(timestamp, :interval)` through the SQL API, CLI, console, or
`sql.run`. Supply a positive integer duration such as `5m`, `1h`, `1d`, or
`2w` (units `s`, `m`, `h`, `d`, `w`). For example:

```sql
SELECT bucket(ts, :bucket) AS t,
       count() AS events
FROM events
WHERE ts >= :from AND ts < :to
GROUP BY t ORDER BY t
```

Seconds, minutes, and hours use fixed durations. Days and weeks use calendar
intervals in the base timezone; a local day can contain 23 or 25 hours.
Pulse compiles the helper to native ClickHouse SQL and binds interval values
and the base timezone as data. The second argument must be a named parameter;
quoted text and comments remain unchanged. Direct ClickHouse clients can use
`toStartOfInterval` themselves.

Three per-base parameterized views provide reset-safe counter calculations:

```sql
SELECT metric, dimensions, increase
FROM increase(metric='http_requests_total', from=:from, to=:to)
```

`increase` and `rate` return one row per series with `series_id`, `metric`,
`dimensions`, `source_id`, `resource_key`, `increase`, and observed `seconds`.
`rate` adds `rate = increase / seconds`, or null when no interval was observed.
A decrease counts the new value as the increase after a reset. The helpers
use raw observations where retained and older hourly increases across the
retention boundary. Windows over expired raw data must contain complete
hours; a partial expired hour returns a SQL error rather than an estimate.

```sql
SELECT dimensions, quantile * 1000 AS p95_ms
FROM histogram_quantile(
  metric='traefik_entrypoint_request_duration_seconds',
  from=:from, to=:to, quantile=0.95
)
```

The histogram metric argument omits `_bucket`. The helper sums counter
increases for equal upper bounds, then calculates the quantile separately for
each source, resource, and label group without `le`. It never combines
quantiles. A changed bucket set returns an error naming the observation time;
for retained hourly evidence, the diagnostic names the affected hour.

### Check limits and recover from errors

`GET /api/pulse/bases/:baseId/sql/limits` returns the profile, memory and time
budget, result limits, hourly usage and reset time, and queue limits.
Three queries can run per Cloud, with one per base. Up to 20 runs can wait
for five seconds. Input errors and admission refusals do not consume hourly
quota. Quota is charged only when a query gets a slot and resets at the next
clock hour. Overview executions and alert checks do not consume the questions quota.

| Code | HTTP | Action |
| --- | --- | --- |
| `INPUT_TOO_LARGE`, `PARAMETER_MISSING`, `SQL_ERROR` | 400 | Reduce input, supply values, or fix SQL; line and column refer to your SQL. |
| `NO_READ_ACCESS` | 403 | Request read access to this base. |
| `TIME_LIMIT`, `MEMORY_LIMIT`, `RESULT_TOO_LARGE` | 422 | Narrow the range, aggregate, or select fewer columns. |
| `QUOTA` | 429 | Wait until the returned reset time; respect `Retry-After`. |
| `BUSY`, `QUEUE_FULL` | 503 | Pulse is busy; wait for `Retry-After` and retry. |
| `STORE_UNAVAILABLE` | 503 | Ask the operator to check ClickHouse or Valkey. |
| `PULSE_STORE_NOT_CONFIGURED` | 503 | Ask a Cloud administrator to connect the data store. |
| `CANCELLED` | 400 | The run was cancelled; start a new run if needed. |

Send a UUID `runId` with a run to cancel before its response arrives. Send that
same ID to `POST /api/pulse/bases/:baseId/sql/cancel`. Only the actor that
started the run can cancel it. Closing the request also cancels the run.

### Save and reuse a query

Use `/api/pulse/bases/:baseId/queries` to list or create queries, and
`/queries/:queryId` to get, update, or delete one. Lists use Cloud pagination.
Saved queries keep a name, SQL, string-valued parameters, revision, and an optional overview pin.
The saved list shows each query’s name, SQL excerpt and last update time.
Select its row to open it in the console.
Names are unique within a base without regard to case. A `PATCH` supplies a
complete snapshot: `name`, `sql`, optional `params`, and `expectedRevision`.
Omitting `params` saves an empty parameter map. A stale revision returns `409`.
An `Idempotency-Key` allows replay of the same saved-query write for 24 hours,
even after later revisions; changing the body with that key returns `409`.
Saving has the same SQL and parameter input checks as execution.
Deletion requires the current `expectedRevision` in its API body and capability
input (CLI: `--expected-revision`). A concurrent edit returns `409`; read the
query again before confirming deletion.

```sh
cld pulse sql --base Ops001 --file requests.sql --param from=2026-10-20 --param to=2026-10-21 --format table
cld pulse queries list --base Ops001
```

Use `--format json` or `--format csv` for export, and `-` to read SQL from
standard input. Ctrl-C sends cancellation. `cld pulse reference sql.md`
describes options and exit codes. `sql.run` and `saved_query.list` need no
approval. The agent result is limited to 100 rows, 500 points, and 256 KiB;
`truncated` marks a shortened result. Points count numeric cells; whole rows
are retained, with 240 KiB reserved for data and 16 KiB for the capability
envelope. `saved_query.save` uses an idempotency
key and revision checks with rememberable approval. Deletion always asks for
approval. There is no capability for tokens or access changes.

## Build a dashboard

Use **Ask AI** to propose a dashboard, or save its JSON plus SQL with
`cld pulse dashboards save --base <base-id> --file dashboard.json`.
Read `cld pulse reference dashboards.md` for a complete website example.
The Assistant asks before saving. Updates use the revision from
`dashboard.read` or `dashboards get` so a stale edit cannot overwrite a newer one.

A dashboard groups number, line, bar, table, and funnel panels into sections.
A named section can include an icon, color, and caption describing its sources
or cadence; these come from the saved definition.
A number panel shows one numeric value. With a DateTime `x`, it uses the last
returned row and shows up to 480 trend points. Optional String columns
`unit`, `detail`, and `detailTone` add a unit and change label.
Choose 24 hours, seven days, 30 days, 90 days, or a custom period. Referenced
`:from`, `:to`, and `:bucket` parameters follow that range. Other values remain
in the panel's `params`. Each panel declares the output `columns` it shows;
charts also choose `x` and optionally `series`. Aggregate to at most eight
series and 480 points per series, with 36 panels and 3,840 marks per panel.
Excessive or truncated results show an error instead of silently losing rows.

Panels retain the base's SQL profile and concurrency limits, separately from
the questions quota. Refreshes run at most once per revision, range, and
60-second interval. On failure, the panel keeps its last successful result
and timestamp when available. Retries back off from one to five minutes.

### Share selected results

Review every output column before publishing. Anyone with the returned link
can read those results. The public page contains presentation and selected
columns, without SQL or parameters. Publishing requires write access and an
explicit confirmation. Assistant publication always asks for approval.

SQL, parameters, selected-column, and output changes end the existing link;
title and layout edits retain it. Publishing again rotates the link. Revoke it
with **Unpublish** or `cld pulse dashboards unpublish`. Clearing measurements
preserves definitions and discards old cached results; deleting a base also
removes its dashboards and public links.

### Dashboard operations in this release

This release adds Postgres dashboard definitions and durable execution
receipts. Back them up with the other Pulse control data. Valkey holds only
result snapshots: at most 500 entries or 64 MiB of serialized keys and data,
evicted by oldest write. Loss or eviction of a snapshot does not permit an
extra calculation within its current interval. Private and public reads have
separate cache keys and validate access on every read. A store outage may
leave a timestamped previous result available; a lost cache means waiting for
the next permitted refresh.

## Let an agent create and write telemetry

`base.create` follows the operator's base creation policy and grants the
creating access subject admin access. `ingest.write` needs base write access
and an HTTP ingest source created by that same access subject. Create the
source with `source.create`, then read its current revision with `source.read`.
Existing sources without a recorded creator continue to accept their source
tokens and authenticated API writes; create a new source for `ingest.write`.

| Action | Input and approval |
| --- | --- |
| `base.create` | `name`, optional `description`; rememberable approval |
| `ingest.write` | `baseId`, `sourceId`, `expectedRevision`, `batch`; whole input at most 192 KiB; rememberable approval per source |
| `base.clear_data` | `baseId`, exact `expectedUpdatedAt` from a fresh `base.read`; base admin; always asks |
| `base.delete` | Same revision and admin requirements; always asks |

All four require an idempotency key. Reuse the same key and unchanged input
when retrying through the platform capability dispatcher. After a provider
5xx or a lost upstream answer, the dispatcher can return
`409 IDEMPOTENCY_UNCERTAIN` without executing again. Inspect stored rows with
SQL and report the uncertain result; do not invent a new key, because part of
the batch may already exist. Direct HTTP ingest has its own same-key retry
contract. A changed source
revision or base timestamp returns 409: read the resource again before
proposing another action. Clear and delete return `{started: true}` when the
lifecycle operation is queued; follow `base.read` for completion. Clearing
preserves sources and configuration; deletion removes the base and its sources.
There are no token or membership capabilities. `source.create` and
`source.update` continue to ask on every call.

## Track a website from its backend

Send `page_view` after the backend serves a page, and `contact_form_sent`
after it accepts and stores a contact request. Keep the source token in the
backend's secret store. Browser JavaScript must never receive it; Pulse has
no browser Beacon or browser tracking snippet. A static site needs a backend
or server function to send these events.

Use canonical paths without query strings, such as `/services`. Supply an
opaque, pseudonymous `sessionId` from the website's own session handling.
Do not send IP addresses, email addresses, form content, or authentication
cookies. Pulse neither creates sessions nor infers unique people.

The repository includes an executable backend example at
`packages/pulse/examples/website-tracking.ts` and a fictional delivery in
`packages/pulse/examples/website-delivery.json`. Create an HTTP source and
save its token to a new protected file:

```sh
cld pulse use Website
cld pulse sources create --name willow-website --kind http_ingest
cld pulse source-tokens create willow-website --name backend --output-file ./website.token
bun packages/pulse/examples/website-tracking.ts --help
bun packages/pulse/examples/website-tracking.ts https://cloud.example/api/pulse/ingest ./website.token ./delivery.json
```

Copy the fictional delivery to `delivery.json` for a test base. Its five events
are dated 19–20 October 2026; use current timestamps and a new delivery key if
those dates are outside retention. A successful response reports five events.
Persist each real delivery's body and key before sending it. On HTTP 429 or
503, leave it pending and respect `Retry-After`. Retry the unchanged body with
the same key within 24 hours, including after a lost response. Replaying the
fixture once still leaves five stored events.

With the base timezone set to `Europe/Berlin`, this query returns one page
view on 19 October and three on 20 October. The same pseudonymous session
crosses midnight. `/services` has two views from two sessions, and `/contact`
has one view and one submitted form:

```sql
SELECT toString(bucket(ts, :bucket)) AS day, JSONExtractString(dimensions,'path') AS path,
       countIf(kind='page_view') AS views,
       uniqExactIf(session_id, kind='page_view') AS sessions,
       countIf(kind='contact_form_sent') AS contacts
FROM events GROUP BY day, path ORDER BY day, path
```

Run the supplied query with `cld pulse sql --file packages/pulse/examples/website.sql --param bucket=1d`, or pass
`{baseId, sql, params: {bucket: "1d"}}` to `sql.run` in Assistant. Save and pin
`SELECT countIf(kind='page_view') AS value FROM events` to show four page
views on Overview. A session count is scoped to the query's grouping; do not
sum per-path sessions to claim a count of unique visitors.

## Send a batch with HTTP ingest

Create an HTTP ingest source and a source token. Keep the token in the
collector's secret store. Send JSON to `POST /api/pulse/ingest` with
`Authorization: Bearer <source-token>` and `Content-Type: application/json`.
The credential selects the source; the body cannot override it.

The body has optional `metrics`, `events`, and `states` arrays. Each array
accepts at most 500 entries, with 1,500 entries total and a 5 MiB limit on the
validated batch's encoded JSON. Empty batches are refused. Metrics use finite
numbers and type `gauge` or `counter`; counters must be nonnegative. The first
accepted value fixes a metric name's type and unit within its base. Later
batches must match both. See `cld pulse reference ingest.md` for fields and examples.

**Send an `Idempotency-Key` from the first attempt.** The key is scoped to the
source and accepts at most 200 characters. Pulse reserves the key and its
acceptance time before writing measurements. For its 24-hour lifetime:

- The same key and identical batch return the same successful
  `{ metrics, events, states }` counts.
- A different batch with that key returns `409`.
- An interrupted batch stays pending. Retrying the same batch with the same
  key writes the same row identities with the original acceptance time.

After expiry, reusing a key starts a new batch and keeps earlier events.

Keep the body and key until delivery completes. Without a key, a failed batch
can already be partly stored. The error says **The batch may be partly
stored, and sending it again can store those parts twice**. Adding a key
afterwards cannot deduplicate the first attempt. Send every batch with an
`Idempotency-Key` from the first attempt to retry safely.

Invalid input or registry caps return `400`, missing ingest access `403`, an
unknown source `404`, and a disabled source, busy or blocked base, or conflicting
key `409`. Successful ingest returns `200` with the three counts. Temporary
refusals and their retry delays are described below.

### Collector error codes

A valid source token keeps identifying its source while collection is paused.
A disabled source returns `409 PULSE_SOURCE_DISABLED`. A provisioning, clearing,
or failed base returns `409 PULSE_BASE_NOT_WRITABLE`; keep the delivery pending
until the operation completes or an administrator repairs the base.
An authenticated lookup of a deleted source or base returns `404 NOT_FOUND`. Normal deletion also revokes its source
tokens, so later requests using those tokens return `401`. Recovery blocks retain
`409 PULSE_BASE_WRITE_BLOCKED` and their recovery guidance.

Schema validation failures and service input errors return `400 BAD_INPUT`.
Fix the batch before retrying. Reusing an idempotency key for a different batch
returns `409 CONFLICT`; retry only the original batch with that key.

## Timestamps, corrections, and states

Omitting `ts` uses the batch's acceptance time. A supplied timestamp must be an
ISO datetime and can be at most five minutes in the future. A future-time error
names the array, item index, metric name, event kind or state key, and timestamp.
Metric timestamps must also fall within raw retention. A sealed metric hour
refuses writes even if retention is later extended.

For the same metric series and timestamp, the newest accepted value wins. The
restricted read view shows the correction at once, without waiting for storage
merges. A correction marks its hour for recomputation and also updates the
counter increase in the hour of the next observation, even across empty hours.

For each state key, source, and dimension/object identity, a newer timestamp
wins. At equal timestamps, later acceptance wins; input order breaks ties in
one batch. Older states change nothing. Pulse stores history for the initial
value and subsequent value changes, while equal values update the current
snapshot without adding history.

A keyed retry completes its original state history even if newer batches have
arrived. Their newer current states remain current. An unkeyed resend of a
failed state batch still records its change once, with the time of the
observation that first carried the new value. If a different value arrives
before the resend, only the newer change is recorded; send state batches with
an `Idempotency-Key` to keep every change.

Hourly metric values keep count, sum, minimum, maximum, last value and its
timestamp, and counter increase. A counter reset contributes its new value;
otherwise the increase is the difference from the previous observation.
Calculation spans empty hours and can use the preceding hourly value after
raw data expires. Corrections trigger recomputation rather than adding to an
old total.

## Scrape Prometheus metrics

A metrics source needs an endpoint. Intervals are whole minutes from 60 to
86,400 seconds. Only one scrape per source runs at a time. Lookup, connection,
headers, and body share a 15-second timeout. Responses must use identity
encoding and fit 10 MiB. A scrape accepts at most 50,000 selected sample lines;
all stored samples use the same collection time.

Pulse accepts declared gauge, counter, and histogram families. Histogram
`_bucket` samples keep the upper bound in the `le` dimension; finite bounds
are normalized. Buckets, `_sum`, and `_count` are stored as counters. Each
label group must have a `+Inf` bucket and nonnegative cumulative bucket counts.
A supplied `_count` must match `+Inf`, and `_sum` cannot be negative. An invalid
group refuses the whole family. The source shows refused families and reasons
(up to 20), plus the number of skipped summary samples. Summaries, untyped,
malformed, and nonfinite samples are skipped.

**Only these metrics (empty = all)** accepts exact family names or a prefix
ending in `*`, separated by commas or newlines. For example, `node_*` includes
families starting with `node_`. Histogram filters name the family, without the
`_bucket`, `_sum`, or `_count` suffix. Filters apply before sample and series
limits; excluded families consume neither. The filter list allows 100 entries
of at most 128 characters, with only a trailing wildcard. That cap comes from
the source configuration's 16 KiB budget: 100 × (128 characters + 3 JSON bytes)
uses 13,100 bytes and leaves room for other configuration.

The CLI supports repeatable `--metric-filter` on `sources create` and
`sources update`. On update, `--clear-metric-filters` includes all families again.

Public endpoints work by default. A Cloud administrator allows internal targets
per base under **Administration → Pulse → Internal targets**: a host or IP
covers every port, `host:port` or `[ipv6]:port` covers one port, and a CIDR
covers every port in its range. `/0` is refused. Reserved names need an exact
host entry. Pulse checks the current entries on save, every scrape, and each
redirect (at most three), resolves again, and pins the connection. Removing an
entry blocks the next scrape and reports how to repair it.

## Quotas, storage, and outages

Values and bytes share a token bucket per base across replicas, HTTP ingest,
CLI ingest, and scrapes. Buckets hold one minute's allowance and refill
continuously. HTTP ingest counts original body bytes; other paths count their
serialized batch. Completed keyed retries return their stored counts without
using quota again while their reset generation and committed/pending checkpoint
identity still match the validated base. A checkpoint identity change invalidates
that completion: retrying replays the original acceptance time and row identities
under the ordinary quotas, and can return `429`. Successful replay renews the
receipt's validity. Checkpoints detect hourly restore mismatches; a matching
checkpoint does not detect every lost batch between checkpoints.

A batch larger than one minute's allowance can use a full bucket. Its full cost
is charged, so later batches wait until enough quota has refilled.

| Condition | Response and recovery |
| --- | --- |
| Base value or byte quota exhausted | `429 PULSE_BASE_THROTTLED` with a whole-second `Retry-After`; wait, then retry the same keyed batch. The source shows throttling for five minutes. |
| Quota service unavailable | `503 PULSE_QUOTA_UNAVAILABLE`, `Retry-After: 30`. |
| Measured base storage reaches its threshold | `409 PULSE_BASE_STORAGE_FULL`; reads continue. Shorten retention or ask a Cloud administrator to raise the threshold. |
| Instance disk below 10% free | `503 PULSE_STORE_DISK_LOW`, `Retry-After: 300`; reads continue. Cloud administrators receive a notification. |
| Data store unreachable | `503 PULSE_STORE_UNAVAILABLE`, `Retry-After: 30`; retry with the same key. Scrapes fail and record the error. |

Storage and disk notifications go once per threshold crossing; store outages
notify once per outage. A successful disk measurement closes the outage.
Delivery follows notification preferences and the recipient rules below.
A failed or throttled scrape waits for its next scheduled attempt.

### Maintenance admission and health delivery in this release

Maintenance SQL shares one fleet-wide NATS lease, beside the three SQL reader
slots. Every admitted maintenance query has a server execution deadline and
an HTTP deadline within its 40-second lease. After an interrupted answer,
Pulse observes cancellation before releasing the slot; if cancellation cannot
be confirmed, the slot remains held until its lease expires. The next owner
first cancels remaining queries from that maintenance lane and observes their
termination before submitting SQL. ClickHouse also limits each maintenance
submission to one concurrent query for the service user, fencing delayed
requests from a stopped replica. Active ingest can defer maintenance; ingest
retains its own settings. Admission waits at most five seconds; busy
lifecycle and rollup work is rescheduled without spending its failure budget. Bounded ingest batches retain their separate admission path.
The memory budget remains one 1 GB maintenance query, three reader profiles,
and the documented reserve for ingestion and ClickHouse background work.

Store-outage and base-storage notices now reach base administrators through
direct, group, and general grants. Delivery expands recipients in 500-user
pages and checks their current access again before sending. A store outage
uses one event identity across bases and Cloud administrators, so a person
with several grants receives one notification for that outage. Cloud disk
notices continue to go to current Cloud administrators.

## Retention and complete metric hours

Raw retention allows 1–730 days by default; Cloud administrators can raise the
maximum to 3,650 days. Hourly values allow 1–3,650 days and sensitive event
fields 1–8,760 hours. Shortening any period requires confirming a preview of
the cutoff, affected rows, and estimated bytes. For sensitive fields, the
preview counts nonempty fields to clear; their event rows remain.
A confirmation in the web app applies only to the settings it previewed; if
someone changed retention in the meantime, Pulse asks you to review the
preview again. The CLI flag `--confirm-shorter-retention` confirms against the
current settings.

ClickHouse TTLs expire events and state history by raw retention, hourly values
by their own retention, and sensitive fields by a separate column TTL.
Physical removal follows storage merges. Current states have no TTL.
SQL reads apply the base's retention even while physical cleanup is pending.
Events use the exact cutoff; raw samples and hourly values include the complete
boundary hour. This applies equally to the console, CLI, Assistant, and alert
queries. Current states remain readable until replaced or cleared.

On update, Pulse reconciles each base to read-schema version 4. Retention
changes update these read boundaries during the same base reconciliation that
updates the storage TTLs. Delayed hourly aggregation continues reading the
protected internal raw samples before the nightly job removes them. Counter
and histogram helpers also use these protected samples within the longer of
raw and hourly retention, so a delayed rollup cannot replace a newer observation
with a stale hourly total. These samples remain hidden from direct raw reads,
and helper windows outside raw retention still require complete hours.

Raw metric samples use daily partitions. The nightly retention job at 03:17
UTC removes a partition only when its whole day is past raw retention and all
recorded metric hours in that day are sealed. Late data and corrections inside
retention mark hours dirty again; the hourly job resumes unfinished hours
after downtime. An hour whose calculation fails waits one hour before its next
attempt, so other bases continue. **Hourly values are lagging** under
**Administration → Pulse → Bases** indicates dirty hours more than three hours
old awaiting processing, or sealing that delays partition removal by more than
a day. Check the hourly and retention jobs before discarding data.

Retention also removes expired request keys and scrape history, and unused
series, metric definitions, event kinds, and state keys. Keys with a current
state remain.

## Check source status and credentials

Open **Sources** or run `cld pulse sources list --json`. Status shows the
newest data timestamp, series count, today’s count, recent throttling, refused histogram families, skipped
summary samples, and the last error and its time. Scrape history adds success,
counts, duration, and finish time; push requests do not create scrape history.

Today starts at midnight in the base timezone. Counts use a five-minute
cache; when the query queue is busy, today’s count is unavailable (`null`).
Today counts retained metric samples, events, and current state rows updated
since midnight. A state row counts once even if its value was reported
several times; this count is not the number of state submissions.

A metrics endpoint's bearer token is bound to its origin (scheme, host, and
port). Changing that origin deletes the stored token unless you supply a
replacement. A path-only change keeps it.

For HTTP ingest, create a separate labeled token per collector deployment:

```sh
cld pulse source-tokens create --base Base01 Src001 --name collector --output-file ./pulse.token
```

`--output-file` is required. It creates a new file with mode `0600` and refuses
an existing path. Text, JSON, and JSONL output contain only ID, name, and path;
the token is never printed. Move it into the collector's secret store without
copying it into chat, logs, or shell arguments.

Run `cld pulse --help` for current commands and open **Help** inside Pulse for
source setup, data types, and recovery.

### Base settings

Open **Settings** in a base for General, Members, Retention, Usage and limits,
and Clear and delete. Base admins can change the name, icon, color, timezone,
members and retention. Readers can inspect settings and see whom to contact
for changes. Shorter retention asks for confirmation of its cutoff and amount.
Choose a color tile and any icon from the picker; the five supported colors
are gray, blue, green, amber, and red. Retention offers presets and a numeric
field for other permitted values.
Usage shows measured storage and hourly SQL consumption against their limits,
plus the query profile, input and concurrency limits. The ingestion rate is
shown as a limit only: the current rate and total series count are not measured
in this view. A missing storage measurement is labeled instead of drawn as zero.
Only Cloud admins change quotas and profiles in **Administration → Pulse → Bases**.
After a quota refusal, the console reloads current usage. If that fails, it
keeps the quota block and offers **Retry** for the usage read.
Closing the modal returns to the underlying view.
