# Pulse ingest

Use one HTTP ingest source per collector boundary. External collectors send to
`POST /api/pulse/ingest` with `Authorization: Bearer <source-token>` and
`Content-Type: application/json`. The token selects the source. Never send it
from browser JavaScript or put it in chat, logs, or shell arguments.

## Create a source and credential

```sh
cld pulse use Operations
cld pulse sources create --name importer --kind http_ingest
cld pulse source-tokens create importer --name production --output-file ./pulse.token
cld pulse source-tokens list importer --json
```

`--output-file` is required and must name a new file. The CLI writes the token
with mode `0600`. Text, JSON, and JSONL output contain only its ID, name, and
path. Transfer the file to the collector's secret store without printing it.
`--expires-at` optionally sets an ISO expiry time. Revoke a credential with
`cld pulse source-tokens revoke importer production --yes`.

For a signed-in person or agent with write access, the CLI can send a batch:

```sh
cld pulse ingest --source importer --file batch.json
# Alternatively, use --stdin or --batch <json>.
```

This uses the authenticated base/source API. It has no idempotency-key flag.
For deliveries that need safe retries, use the source-token HTTP route with an
`Idempotency-Key` from the first attempt.

## Track backend website events

Send `page_view` after serving a page and `contact_form_sent` after accepting
a form. Use canonical `dimensions.path` without query strings and an opaque,
pseudonymous `sessionId` from the website. Omit IP addresses, email addresses,
and form content. Keep the source token on the backend; there is no Beacon.
The executable repository example is `packages/pulse/examples/website-tracking.ts`
(`--help`), with `website-delivery.json` as a fictional persisted delivery.
Read the [backend tracking guide](/en/apps/pulse#track-a-website-from-its-backend)
for setup, retry behavior and the expected day/path/session counts.

Agents may instead call `ingest.write` with `baseId`, `sourceId`, the current
`expectedRevision`, and `batch` (whole input at most 192 KiB). This needs base
write access and a source created by the current access subject. It accepts
remembered approval per source and requires an idempotency key. Source token
and membership management remain outside capabilities. Capability dispatch
can return `409 IDEMPOTENCY_UNCERTAIN` after a provider 5xx or lost upstream
answer; it will not call the writer again. Inspect stored rows with SQL and
report the uncertainty. Do not use a new key for a potentially partial batch.
The direct HTTP/CLI ingest retries described below have a separate contract.

## Build a batch

The JSON object accepts `metrics`, `events`, and `states` arrays. Omit arrays
that you do not need. A batch must contain at least one item.

```json
{
  "metrics": [{ "name": "orders.total", "value": 142, "type": "counter", "unit": "count", "dimensions": { "channel": "web" } }],
  "events": [{ "kind": "order.completed", "value": 149.9, "dimensions": { "channel": "web" }, "attributes": { "orderId": "order-123" } }],
  "states": [{ "key": "shop.online", "value": true }]
}
```

| Item | Fields |
| --- | --- |
| Metric | Required nonempty `name` and finite numeric `value`; optional `type` (`gauge`, the default, or `counter`) and nonempty `unit` or null. Counters must be nonnegative. |
| Event | Required nonempty `kind`; optional finite numeric `value` or null, `actorId`, `sessionId`, `correlationId`, `attributes`, `sensitive`, and `payload`. |
| State | Required nonempty `key` and `value` (string, finite number, boolean, or null). |
| All items | Optional ISO datetime `ts`, `dimensions`, and explicit `resource: {type, id, label?}` or null. `sourceId` is refused; the credential or authenticated route selects the source. |

The optional object identity stays part of metric and state identity. Its type
is a lowercase slug matching `[a-z][a-z0-9._-]*`; its full `type:id` key has at
most 505 characters. The type allows 80 characters, ID 500, and label 240;
the combined-key limit also applies. Omit it when no stable observed object is needed.
Pulse does not infer this identity from generic ingest dimensions.

Dimensions distinguish variants by source and object identity. Pulse trims
keys, drops null values, converts other values to strings, and sorts keys.
Keep reusable labels such as route templates, region, or channel here. Put
request IDs, full URLs, and other unique details in event `attributes` or
identity fields; protected data belongs in `sensitive`, and nested details in
`payload`. Pulse does not derive visitor identities or sessions.

| Per-call limit | Maximum |
| --- | --- |
| Each collection | 500 metrics, 500 events, 500 states |
| Combined items | 1,500 |
| Validated batch encoded as JSON | 5 MiB |
| Dimension keys / key length / stringified value length | 32 / 80 characters / 500 characters |
| Attributes | 64 top-level keys, 32 KiB JSON, 4 nested levels |
| Sensitive fields | 32 top-level keys, 32 KiB JSON, 4 nested levels |
| Attribute and sensitive key length | 80 characters; nonempty |
| Payload | 64 KiB JSON, 8 nested levels |
| Idempotency key | 200 characters |
| Variants for one metric in a base | 10,000 |

The external batch limits also apply to `cld pulse ingest`. Per-base series,
event-kind, and state-key limits can refuse otherwise valid input.

## Keep timestamps and corrections consistent

Omitting `ts` uses the batch's acceptance time. All supplied timestamps can be
at most five minutes in the future. The error names the collection, item
index, metric name, event kind or state key, and offending timestamp. Metric
timestamps must also be within raw retention. Sealed metric hours reject
writes even after retention is extended.

A metric series is identified by metric name, source, object identity, and
normalized dimensions. For the same series and timestamp, the newest accepted
value wins and the read view shows it immediately. The first accepted sample
fixes type and unit per metric name within a base; later input must match both,
including an omitted unit. Conflicts reject the batch before measurement writes.

For states, the newer timestamp wins. At equal timestamps, later acceptance
wins; input order breaks ties within a batch. Older snapshots change nothing.
History records the initial value and real value changes only. Repeated equal
values update the current snapshot without another history row. Different
sources never overwrite each other's states.

Hourly values retain count, sum, minimum, maximum, last value and timestamp,
and counter increase. Resets contribute the new counter value; otherwise the
increase is the difference from the predecessor, even across gaps. Corrections
recompute the affected hour and the hour of the next observation. A preceding
hourly value supplies the starting value after raw data expires.

## Retry one delivery safely

Generate a key per logical batch and send it as the `Idempotency-Key` HTTP
header from the first attempt. Persist the unchanged body and key until delivery
finishes. A key belongs to one source and lives for 24 hours from reservation.

Pulse commits the reservation before measurement writes. The same key and
identical batch return the same successful `{ metrics, events, states }`
counts. Different content returns `409`. A failed write keeps the key pending;
retrying it uses the same acceptance time and row identities, so it writes the
same rows. Completed retries do not consume quota again while the receipt's
reset generation and committed/pending checkpoint identity match the validated
base. If that identity changes, the next retry replays the original acceptance
time and row identities under ordinary quotas and may return `429`. A successful
replay renews completion for that identity. Checkpoint mismatches block writes
until an administrator corrects and rechecks the restore. A matching hourly
checkpoint cannot detect every batch lost between checkpoints.

Without a key, a failed batch can already be partly stored. Its error includes
**The batch may be partly stored, and sending it again can store those parts
twice**. Adding a key after the first failure cannot deduplicate that earlier
attempt. Send every batch with an `Idempotency-Key` from the first attempt to
retry safely.

| Outcome | HTTP response |
| --- | --- |
| Accepted | `200`, counts for metrics, events, and states |
| Invalid batch, timestamps, sealed hours, or registry caps | `400`; no measurements written |
| No ingest access | `403` |
| Unknown source | `404` |
| Key conflict, disabled source, busy or blocked base | `409` |
| Base storage threshold reached | `409 PULSE_BASE_STORAGE_FULL`; reads continue |
| Value or byte quota exhausted | `429 PULSE_BASE_THROTTLED`, whole-second `Retry-After` |
| Quota service unavailable | `503 PULSE_QUOTA_UNAVAILABLE`, `Retry-After: 30` |
| Store unavailable | `503 PULSE_STORE_UNAVAILABLE`, `Retry-After: 30` |
| Instance disk below 10% free | `503 PULSE_STORE_DISK_LOW`, `Retry-After: 300`; reads continue |

Wait for `Retry-After` before retrying an unchanged keyed batch. Fix other
client errors first. A batch larger than one minute's allowance can use a full
bucket. Its full cost is charged, so later batches wait until enough quota has
refilled.

Values and bytes use continuously refilled token buckets per base, shared
across replicas and HTTP, CLI, and scrape paths. HTTP counts original request
bytes; other paths count serialized batch bytes. Quota refusals mark the source
as throttled for five minutes. A base administrator can shorten retention when
storage is full; a Cloud administrator can raise its threshold.

Direct user base administrators receive one storage notification per crossing;
group access is not expanded. Cloud administrators receive one disk notification
per crossing and one notification per store outage, subject to preferences.
A successful disk measurement ends the outage.


### Collector error codes

A valid source token keeps identifying its source while collection is paused.
A disabled source returns `409 PULSE_SOURCE_DISABLED`. A provisioning, clearing,
or failed base returns `409 PULSE_BASE_NOT_WRITABLE`; keep the delivery pending
until the operation completes or an administrator repairs the base. An authenticated lookup of a deleted
source or base returns `404 NOT_FOUND`. Normal deletion also revokes its source
tokens, so later requests using those tokens return `401`. Recovery blocks retain
`409 PULSE_BASE_WRITE_BLOCKED` and their recovery guidance.

Schema validation failures and service input errors return `400 BAD_INPUT`.
Fix the batch before retrying. Reusing an idempotency key for a different batch
returns `409 CONFLICT`; retry only the original batch with that key.

## Set up Prometheus collection

```sh
cld pulse sources create --name node --kind metrics \
  --endpoint-url https://metrics.example.com/metrics \
  --scrape-interval-seconds 60 \
  --metric-filter 'node_*' --metric-filter up
cld pulse sources update node --metric-filter 'node_cpu*'
cld pulse sources update node --clear-metric-filters
cld pulse sources scrape node --json
cld pulse sources scrapes node --json
```

Filters match exact family names or `prefix*`. Only a trailing wildcard is
allowed; other characters follow Prometheus metric-name syntax. An empty list
includes all families. `--clear-metric-filters` is update-only and cannot be
combined with `--metric-filter`. Histogram filters use the parent family name.

At most 100 filters of 128 characters fit the source configuration's 16 KiB
budget: 100 × (128 + 3 JSON bytes) = 13,100 bytes, leaving room for other fields.
Filtered-out families consume neither the sample cap nor series budgets.

Intervals are multiples of 60 seconds from 60 through 86,400. Fetching lookup,
connection, headers, and body has one 15-second deadline. The response limit is
10 MiB, with identity encoding only, and at most 50,000 selected sample lines.
Only one scrape per source runs at a time. Accepted samples share a collection
time; timestamps in the exposition do not override it.

The adapter accepts declared gauges, counters, and histograms. Histograms store
`_bucket` with normalized `le` dimensions, `_sum`, and `_count` as counters.
Every label group needs `+Inf` and nonnegative cumulative buckets; a supplied
count must match `+Inf`, and the sum cannot be negative. One invalid group
refuses its whole family. Source status lists up to 20 family/reason pairs:
`missing_inf`, `not_cumulative`, `count_mismatch`, or `negative_sum`.
Summaries are skipped and counted as samples in `skippedSummaries`; untyped,
malformed, and nonfinite samples are skipped too. Included but skipped lines
still count toward the sample limit.

The adapter uses `instance`, `host`, or `node` for target identity, falling back
to the endpoint host and port. Internal endpoints require a Cloud administrator
to allow the target for this base under **Administration → Pulse → Internal
targets**. Read [Administration](admin.md) for target entries.

Pass endpoint credentials only with `--bearer-token-file` or
`--bearer-token-stdin`. A scheme, host, or port change deletes the stored bearer
token unless a replacement is supplied. Changing only the path keeps it.

## Inspect collection and retention

`sources list --json` exposes `status.newestDataAt`, `throttled`, `throttledAt`,
`refusedHistograms`, `skippedSummaries`, `lastError`, and `lastErrorAt`.
Histogram and summary diagnostics describe the latest scrape. Scrape history
records attempts, counts, duration, and failures, including store and quota
refusals; such failures wait for the next scheduled attempt. HTTP ingest updates
source health and token usage without creating scrape-attempt rows.

Events and state history expire by raw TTL, hourly values by rollup TTL, and
sensitive event fields by a separate column TTL. Current states do not expire.
Raw metric partitions are dropped by nightly retention at 03:17 UTC only when
the whole day is expired and every recorded hour is sealed. Late samples and
corrections mark hours dirty for recomputation. **Hourly values are lagging**
in **Administration → Pulse → Bases** warns about delayed hourly calculation
or sealing. See the [Pulse guide](/en/apps/pulse#retention-and-complete-metric-hours).

Return to [Pulse CLI](index.md) for base, access, and lifecycle commands.
