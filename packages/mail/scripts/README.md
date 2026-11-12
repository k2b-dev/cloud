# Mail scripts

- `browser-smoke.ts` — Playwright regression smoke against a running dev server (seeds a mailbox through the persistence boundary): `bun packages/mail/scripts/browser-smoke.ts --base-url http://localhost:3000`

Integration suites are gated by environment: `bun run --cwd packages/mail test:integration` runs them with the integration preload; the connector conformance suite runs with `bun test packages/mail/src/service/connectors/connector-conformance.integration.test.ts` from the repository root.

The large-mailbox measurements need the integration preloads. From the repository root, with the `CLOUD_TEST_*` targets exported, run:

```sh
MAIL_PERFORMANCE_TESTS=1 MAIL_PERFORMANCE_MESSAGE_COUNT=100000 bun --no-env-file test --timeout 600000 \
  --preload ./scripts/fixtures/test-infra.ts --preload ./packages/mail/test/integration-preload.ts \
  packages/mail/src/service/performance.integration.test.ts packages/mail/src/service/view-counts.integration.test.ts \
  packages/mail/src/service/focus-performance.integration.test.ts \
  packages/mail/src/service/view-count-cache-large.integration.test.ts
```

Without `MAIL_PERFORMANCE_TESTS=1`, the performance suite is skipped, and the view counts and Focus suites run with 25,000 messages as part of the integration suites; the Focus suite spreads them over four mailboxes. At that size PostgreSQL would compile the counts and the Focus reads with JIT inlining and optimization, so both suites fail if a read stops turning JIT off; smaller values of `MAIL_PERFORMANCE_MESSAGE_COUNT` are raised to it.

## Measure Mail at mailbox scale

`perf-baseline.ts` seeds two deterministic large mailboxes (default per mailbox: 20,000 messages, 3,000 conversations, 30 folders; `--folders 350` for the folder scale from #1268) into a run-owned production stack and measures SSR and API scenarios with statement counts and explain plans:

```sh
bun --no-env-file packages/mail/scripts/perf-baseline.ts --runs 5
```

It needs Docker, takes the machine-wide heavy lock, never uses port 3000 or the development database, and writes `.local/mail-perf/<UTC timestamp>/result.json` and `summary.md`. `--browser chromium,webkit` adds page loads and nine interactions in the run-owned Playwright container; `--rank <result.json> --bottlenecks <candidates.json>` prints the top 5 bottlenecks backed by that result. `--compare <earlier result.json>` adds median deltas.

`--interactions mailbox-switch,folder-switch --loads none` selects only those browser interactions and skips standalone page-load measurements; both mailboxes and all server scenarios still run. `mailbox-switch-route` measures B's workspace route, and `ssr-mailbox-b` measures B's document. B uses seed + 1 (wrapping at 2^32) and records its seed duration separately.

`folder-switch-full` starts in A's medium folder and clicks A's Inbox (phone: in the app menu). Before each sample, it requires A's Inbox and B's default workspace-route page 1 to have the same row count (50 each); it ends with the Inbox heading, its first row visible, and the list not busy. Use `--interactions mailbox-switch,folder-switch,folder-switch-full --loads none` for the equal-row comparison alongside the original medium-folder switch. One extra traced Chromium sample per profile for mailbox and both folder switches reports JS, parse/compile, island render, style/layout, and other task time, separately from timing samples.

The fixture lives in `packages/mail/test/fixtures/large-mailbox.ts`; an integration test keeps it in step with real ingest. Flags, scenarios, fixture shape and limitations: `--help` and [Measure production page performance](../../../docs-site/docs/en/contributing/performance-baseline.md#measure-mail-at-mailbox-scale).

## Measure Mail memory under hydration load

With `CLOUD_TEST_DATABASE_URL`, `CLOUD_TEST_NATS_SERVERS`, and `CLOUD_TEST_VALKEY_URL` exported (plus `CLOUD_TEST_NATS_CREDS_FILE` when needed), run:

```sh
bun --no-env-file packages/mail/scripts/memory-load.ts --profile guard --json
```

The script takes the heavy lock, creates a disposable `mail_*_test` database and private Sync namespace, and runs real hydration, extraction, API reads and folder sync against simulated IMAP. `incident` (default) uses four mailboxes, each with 40 small folders and an INBOX with three 10–40 MiB messages and 20 small messages. `guard` keeps four mailboxes with fewer messages and targets a run under 90 seconds; host load can extend it. `--only`, `--html-mib` and `--csv-mib` isolate load paths; `--help` lists all overrides without connecting.

Results go to `.local/mail-memory/<UTC timestamp>/`: `samples.ndjson`, `summary.json` and `summary.md`. RSS is sampled by a worker every 20 ms; heap and database state samples pause during main-thread stalls. API traffic stays in process; there is no browser or real IMAP/network latency. See [measurement details and limits](../../../docs-site/docs/en/contributing/performance-baseline.md#measure-mail-memory-under-hydration-load).

## Measure collaborative draft capacity

Export isolated `CLOUD_TEST_DATABASE_URL`, `CLOUD_TEST_NATS_SERVERS`, and
`CLOUD_TEST_VALKEY_URL` targets, then run:

```sh
BUN_OPTIONS=--no-env-file nice -n 19 bun --smol packages/mail/scripts/draft-document-load.ts \
  --drafts 50 --clients 3 --seconds 90 --rss-mib 1024
```

Use your own resource-limited Postgres, JetStream and Valkey containers and a
process cgroup. `--smol` encourages GC; it is not a heap cap. The script creates
and deletes a private database and broker namespace, replaces only browser
credential verification, and drives the real Mail socket/service path. It does
not start infrastructure or enable shared editing for mailboxes.

Each client keeps at most one unconfirmed typing burst and resends its local
state with the original base cursor after reconnecting. Awareness, graceful
reconnect, abrupt disconnect, request abort, and a TCP peer that stops reading
exercise cleanup. The result must pass final text convergence against committed
SQL state. Scale in separate runs; the script stops above host load 40 or its RSS
budget, and limits a measured step to ten minutes. `--body-bytes 262144
--burst-bytes 65536 --interval-ms 100` adds repeated paste/delete pressure to the
first editor of each draft; it is a separate stress profile. A closed-loop
workload slows its offered rate when acknowledgements slow down.

`--out` selects a new directory containing `samples.ndjson` and `summary.json`.
Samples report RSS/heap, socket buffers, both topics' event and dead-letter stream
states, and database row/byte growth. The summary includes peak/end/after-GC
memory, a fixed-size 10 ms propagation latency histogram's p50/p95, close/error
counts, and cleanup counters. One-second samples can miss short allocation
spikes, and the same process includes simulated clients. No result establishes
capacity for maximum-size documents or simultaneous Mail imports and sending.
See [Mail shared draft capacity](../../../docs-site/docs/en/operations/mail-shared-draft-capacity.md)
for the production limits. A stalled statistics read fails after 30 seconds;
cleanup steps each have a ten-second deadline. If cleanup fails, the process
exits nonzero after writing its summary. Remove the run's disposable database
and Sync namespace before reusing its infrastructure.
