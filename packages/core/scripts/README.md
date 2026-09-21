# Core scripts

- `build-extras.ts` — build hook invoked by `packages/cloud/scripts/build.ts` (needs `WORKSPACE_ROOT`, `DIST_DIR`); copies global CSS, fonts and icon assets into the dist.
- `dev-extras.ts` — dev-mode counterpart invoked by `packages/cloud/scripts/preload.ts` (needs `PUBLIC_DIR`).
- `font-assets.ts` — builds the IBM Plex font assets; imported by the extras scripts and the docs site.
- `tabler-assets.ts` — builds the Tabler icon font assets; imported by the extras scripts.
- `sync-dev-smoke.ts` — HTTP acceptance smoke for sync admin routes, run inside the dev Compose stack: `docker compose -f compose.dev.yml exec -T app-core bun packages/core/scripts/sync-dev-smoke.ts`
- `repair-jsonb-containers.ts` — repairs JSONB container columns on a database: `bun packages/core/scripts/repair-jsonb-containers.ts --help`
