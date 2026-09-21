# Cloud platform scripts

- `build.ts` — production build for one Cloud app (`APP_ID`); used by the Dockerfiles and `bun run build` targets.
- `preload.ts` — dev-mode preload that registers the SSR plugin and builds CSS before app code loads.
- `build-pdf-renderer.ts` — packages the PDF decoder and native assets for bundles that import PDF vision.
- `app-favicon.ts` — generates app favicons from Tabler icons; imported by `build.ts` and `preload.ts`.
- `browser-performance.ts` — bundles the web-vitals browser asset for core; imported by `build.ts` and `preload.ts`.
- `runtime-recovery-acceptance.ts` — shared-runtime recovery acceptance on disposable Docker containers: `bun packages/cloud/scripts/runtime-recovery-acceptance.ts` (also `bun run test:runtime-recovery`).
- `runtime-recovery-worker.ts` — the containerized fixture started by `runtime-recovery-acceptance.ts`; not run directly.
- `sync-recovery-smoke.ts` — two-phase NATS recovery smoke: `bun packages/cloud/scripts/sync-recovery-smoke.ts prepare --namespace cloud-recovery-smoke-<unique>`, restart the fleet, then `... recover --namespace <same>`.
