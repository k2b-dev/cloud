# Mail scripts

- `browser-smoke.ts` — Playwright regression smoke against a running dev server (seeds a mailbox through the persistence boundary): `bun packages/mail/scripts/browser-smoke.ts --base-url http://localhost:3000`

Integration suites are gated by environment: `bun run --cwd packages/mail test:integration` runs them with the integration preload; the connector conformance suite runs with `bun test packages/mail/src/service/connectors/connector-conformance.integration.test.ts` from the repository root.

The large-mailbox measurements need the integration preloads. From the repository root, with the `CLOUD_TEST_*` targets exported, run:

```sh
MAIL_PERFORMANCE_TESTS=1 MAIL_PERFORMANCE_MESSAGE_COUNT=100000 bun --no-env-file test --timeout 600000 \
  --preload ./scripts/fixtures/test-infra.ts --preload ./packages/mail/test/integration-preload.ts \
  packages/mail/src/service/performance.integration.test.ts packages/mail/src/service/view-counts.integration.test.ts \
  packages/mail/src/service/focus-performance.integration.test.ts
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
