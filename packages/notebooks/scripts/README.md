# Notebooks scripts

- `build-extras.ts` — build hook invoked by `packages/cloud/scripts/build.ts` (needs `DIST_DIR`); copies the KaTeX assets.
- `dev-extras.ts` — dev-mode counterpart invoked by `packages/cloud/scripts/preload.ts` (needs `PUBLIC_DIR`).
- `math-assets.ts` — builds the KaTeX asset bundle; imported by the extras scripts.
- `snapshot-cutover-preflight.ts` — read-only gate for the Yjs snapshot cutover, run with the installation's runtime configuration (`SYNC_NAMESPACE`, `NATS_SERVERS`, `DATABASE_URL`, optional `NATS_CREDS_FILE`, `NATS_TLS_CA_FILE`): `bun packages/notebooks/scripts/snapshot-cutover-preflight.ts`
