---
name: cloud-pulse
description: Set up Pulse bases, sources, Prometheus scrapes and filters, ingest metrics, events and states, inspect collection status, and guide Cloud administrators through ClickHouse setup and recovery.
---

# Pulse

Pulse collects metrics, events, and states in bases. SQL questions and new
dashboards arrive later. There is no measurement-query command or capability
now; do not invent a query, dashboard, catalog, or browsing workflow.

## Discover the base and current commands

Read `cld pulse reference`, then `cld pulse --help`. Use
`cld pulse reference ingest.md` for batches, retries, and scrape limits, or
`cld pulse reference admin.md` for Cloud administration.

List bases with `cld pulse list --json`. Resolve an exact name or returned ID;
use `cld pulse use <base>` or pass `--base <base>` explicitly. Inspect
`cld pulse get --json` before changing retention, clearing, or deleting.

By default, people and agents with write/admin credential scope can create a
base and receive its admin access. A delegated agent creates for its person.
Cloud administrators can restrict creation; every service account counts as an
agent under the people-only policy. Source-bound credentials cannot create bases.
Base access and credential scopes both constrain later operations.

## Configure sources and safe delivery

Use `sources create --kind http_ingest --name <name>` for a producer that sends
batches. Source-token management requires a person-backed identity and base
admin access. Have an authorized person create the credential when the agent
cannot do it:

```sh
cld pulse source-tokens create --base Base01 Src001 --name collector --output-file ./pulse.token
```

The required output file must be new. The CLI writes mode `0600` and prints
only ID, name, and path in every mode. Keep the token out of agent context,
chat, logs, and arguments. Transfer it into the producer's secret store.

The collector sends JSON to `POST /api/pulse/ingest` with the source token as
its Bearer credential and an `Idempotency-Key` from the first attempt. Persist
the body and key. Pulse reserves the key before writing; the same key and batch
return the same successful counts during its 24-hour lifetime. A pending retry
writes the same row identities with the original acceptance time. Different
content returns 409. A failed unkeyed batch can be partly stored; adding a key
afterwards cannot deduplicate its earlier rows.

`cld pulse ingest --source <source> --file <path>` uses authenticated base
access and has no idempotency flag. Use the source-token HTTP route when safe
retries are needed. Read the ingest reference before constructing a batch;
respect per-call and per-base budgets and wait for `Retry-After` on temporary refusals.

For Prometheus, use `sources create --kind metrics --name <name>` with
`--endpoint-url`. Repeat `--metric-filter` for exact family names or `prefix*`.
Quote wildcards in the shell. On update, `--clear-metric-filters` includes all
families again. Filtered families consume no sample or series budget.
Histograms are accepted after validation; summaries are skipped.

Pass endpoint bearer credentials only through `--bearer-token-file` or
`--bearer-token-stdin`. Changing the endpoint origin deletes the stored token
unless a replacement is supplied. Never read a secret file into agent context.

## Read status before repairing

Use `sources list --json` for newest data time, recent throttling, refused
histograms, skipped summary samples, and errors. `sources scrapes <source>
--json` adds attempt history; `sources scrape <source>` starts a scrape.
The capabilities `pulse.base.search`, `pulse.base.list`, `pulse.base.read`,
`pulse.source.list`, and `pulse.source.read` expose base/source status, not
measurement queries.

For throttling, reduce work or wait for the stated retry delay. At a base
storage threshold, reads remain available: propose shorter retention or a
Cloud administrator's limit change. Below the instance disk threshold or during
a store outage, repair the store before resuming writes. Check source errors
and failed scrape history after recovery.

## Connect or recover the store

The operator provides a dedicated ClickHouse instance. A Cloud administrator
connects it under **Administration → Pulse → Data store**. Without it, Pulse
shows **Pulse is not set up yet**; other apps remain available. Use
`admin store get|check|setup-sql|set` and the admin reference. Pass passwords
only with `--password-file` or `--password-stdin`; never print or inspect them.
The operator runs the generated setup SQL as the ClickHouse administrator.

Cloud administrators use `admin policy get|set`, `admin bases
list|limits|retry|recheck|recreate`, `admin orphans list|delete`, and
`admin targets list|add|remove`. Internal targets are per-base host, host:port,
or CIDR entries; `/0` is refused. They are configured under
**Administration → Pulse → Internal targets**.

A failed lifecycle operation needs Retry. A checkpoint mismatch or missing
database blocks writes and clearing. Restore matching backups, then ask a
Cloud administrator to check again. Starting empty discards measurements.
Shortening retention needs review and confirmation of its cutoff and affected
data preview. Obtain explicit approval for clearing, deleting, recreating,
revoking credentials, or removing access; inspect the exact target first.
