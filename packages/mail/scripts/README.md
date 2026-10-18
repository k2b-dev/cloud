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

`perf-baseline.ts` seeds a deterministic large mailbox (default 20,000 messages, 3,000 conversations, 30 folders; `--folders 350` for the folder scale from #1268) into a run-owned production stack and measures SSR and API scenarios with statement counts and explain plans:

```sh
bun --no-env-file packages/mail/scripts/perf-baseline.ts --runs 5
```

It needs Docker, takes the machine-wide heavy lock, never uses port 3000 or the development database, and writes `.local/mail-perf/<UTC timestamp>/result.json` and `summary.md`. `--browser chromium,webkit` adds page loads and six interactions in the run-owned Playwright container; `--rank <result.json> --bottlenecks <candidates.json>` prints the top 5 bottlenecks backed by that result. `--compare <earlier result.json>` adds median deltas. The fixture lives in `packages/mail/test/fixtures/large-mailbox.ts`; an integration test keeps it in step with real ingest. Flags, scenarios, fixture shape and limitations: `--help` and [Measure production page performance](../../../docs-site/docs/en/contributing/performance-baseline.md#measure-mail-at-mailbox-scale).
