# Mail scripts

- `browser-smoke.ts` — Playwright regression smoke against a running dev server (seeds a mailbox through the persistence boundary): `bun packages/mail/scripts/browser-smoke.ts --base-url http://localhost:3000`

Integration suites are gated by environment: `bun run --cwd packages/mail test:integration` runs them with the integration preload; the connector conformance suite runs with `bun test packages/mail/src/service/connectors/connector-conformance.integration.test.ts` from the repository root.

The large-mailbox measurements need the integration preloads. From the repository root, with the `CLOUD_TEST_*` targets exported, run:

```sh
MAIL_PERFORMANCE_TESTS=1 MAIL_PERFORMANCE_MESSAGE_COUNT=100000 bun --no-env-file test --timeout 600000 \
  --preload ./scripts/fixtures/test-infra.ts --preload ./packages/mail/test/integration-preload.ts \
  packages/mail/src/service/performance.integration.test.ts packages/mail/src/service/view-counts.integration.test.ts
```

Without `MAIL_PERFORMANCE_TESTS=1`, the performance suite is skipped and the view counts suite runs with 5,000 messages as part of the integration suites.
