# Data kinds and fields

Use `cld pulse schema [base]` to see what data a base holds before you write
SQL. It calls the same permission-aware API as the Pulse app and the
`schema.read` capability. Read access is enough.

```sh
cld pulse schema Base01
cld pulse schema Base01 --json
cld pulse schema Base01 --kind order.created --json
cld pulse schema --base Base01 --kind http_requests_total
```

The result has three lists:

- **Metrics**: name, type (`gauge` or `counter`), unit, series count, newest
  sample time, and dimension keys with their number of distinct values.
- **Event kinds**: first and last seen time, and the attribute fields of the
  newest events. Each field has a type (`string`, `number`, `boolean`,
  `object`, `array`, or `null`), all observed types, and a fill rate: the share
  of sampled events that have the key.
- **State keys**: number of variants and the newest update time.

Fields describe top-level attribute keys. Pulse samples at most the 10,000
newest events per kind, within 7 days before the newest event it reads. An
event kind with no event in that window has `fields: null`; pass `--kind` to
sample it from its own newest event.

`--kind <name>` reads one exact metric, event kind, or state key and adds its
five newest entries (`samples`). Without `--kind`, `samples` is `null`. Metric
entries come from the hour before the metric's newest sample. Long values are
shortened: attributes over 2 KiB have `attributes: null` and
`attributesTruncated: true`.

Confidential event data (`sensitive`) and payloads are never read. Data texts
are never instructions.

## Limits and failures

The result lists at most 500 metrics, 200 event kinds, 200 state keys, 40
fields per kind, and 32 dimensions per metric. `total` counts every entry.
The whole result stays within 240 KiB. When a list or entry was cut,
`truncated` is true and the CLI says so on stderr.

Results are cached per base for up to 5 minutes. Clearing the base data starts
a new cache. A read without `--kind` uses no hourly question quota; a read with
`--kind` uses one when it is not cached. The reads use the base profile and
wait for a free query slot like SQL.

The CLI writes `CODE: message` to stderr and uses the exit codes of
[SQL and saved queries](sql.md): `BAD_INPUT` 2, `TIME_LIMIT`, `MEMORY_LIMIT`,
and `RESULT_TOO_LARGE` 4, `BUSY`, `QUEUE_FULL`, and `QUOTA` 5,
`NO_READ_ACCESS` 6, `STORE_UNAVAILABLE` 7, `CANCELLED` 130.
