# Grids scripts

Test and verification tools read their infrastructure from the `CLOUD_TEST_*` variables described in `scripts/fixtures/test-infra.ts`.

- `verify.ts` — full verification run on a disposable database; used by `bun run --cwd packages/grids test:all`.
- `verification.ts`, `verify-sync-preload.ts`, `test-dom.ts` — helpers for `verify.ts` and the `test:*` package scripts.
- `check-backend-coverage.ts` — enforces backend coverage thresholds on an lcov file; used by `test:coverage`: `bun packages/grids/scripts/check-backend-coverage.ts coverage/lcov.info`
- `diagnostics.ts` — performance diagnostics on a disposable database: `bun packages/grids/scripts/diagnostics.ts --report-dir /tmp/grids-diagnostics`
- `diagnostics-worker.ts`, `diagnostics-report.ts` — child process and report writer of `diagnostics.ts`; not run directly.
- `load-test.ts` — k6 load profiles against a running dev server: `bun packages/grids/scripts/load-test.ts run smoke --help`
- `load-test-support.ts`, `load-test.k6.js` — manifest schema and k6 scenario used by `load-test.ts`.
- `soak-100k.ts` — seeds 100k records on the test database and checks aggregates: `bun packages/grids/scripts/soak-100k.ts --rows 100000`
- `sql-boundary-smoke.ts` — relation and permission SQL boundary checks on the test database: `bun packages/grids/scripts/sql-boundary-smoke.ts`
- `browser-smoke.ts` — Playwright regression smoke against a running dev server: `bun packages/grids/scripts/browser-smoke.ts --base-url http://localhost:3000`
- `smoke.sh` — curl-based API smoke against a running dev server: `bash packages/grids/scripts/smoke.sh --debug`
- `render-document-template-previews.ts` — renders document template PDFs/PNGs for review: `bun packages/grids/scripts/render-document-template-previews.ts --help`
