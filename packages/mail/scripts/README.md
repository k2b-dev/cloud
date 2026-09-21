# Mail scripts

- `browser-smoke.ts` — Playwright regression smoke against a running dev server (seeds a mailbox through the persistence boundary): `bun packages/mail/scripts/browser-smoke.ts --base-url http://localhost:3000`

Integration suites are gated by environment: `bun run --cwd packages/mail test:integration` runs them with the integration preload; the connector conformance and 100k performance suites run with `bun test packages/mail/src/service/connectors/connector-conformance.integration.test.ts` and `MAIL_PERFORMANCE_TESTS=1 MAIL_PERFORMANCE_MESSAGE_COUNT=100000 bun test packages/mail/src/service/performance.integration.test.ts` from the repository root.
