# Notebooks scripts

- `build-extras.ts` — build hook invoked by `packages/cloud/scripts/build.ts` (needs `DIST_DIR`); copies the KaTeX assets.
- `dev-extras.ts` — dev-mode counterpart invoked by `packages/cloud/scripts/preload.ts` (needs `PUBLIC_DIR`).
- `math-assets.ts` — builds the KaTeX asset bundle; imported by the extras scripts.
- `snapshot-cutover-preflight.ts` — read-only gate for the Yjs snapshot cutover, run with the installation's runtime configuration (`SYNC_NAMESPACE`, `NATS_SERVERS`, `DATABASE_URL`, optional `NATS_CREDS_FILE`, `NATS_TLS_CA_FILE`): `bun packages/notebooks/scripts/snapshot-cutover-preflight.ts`
- `large-notebook.ts` — seeds fictional 13-, 1,307- and 20,000-page notebooks into the development Cloud and times the main notebook paths against them: `bun packages/notebooks/scripts/large-notebook.ts --help`. `large-notebook-fixture.ts` holds the deterministic shapes; integration tests insert them with `src/service/large-notebook.test-fixture.ts`.
