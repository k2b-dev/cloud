# Gateway ops scripts

- `dev-nats.ts` — prepares the local NATS accounts (`DEV`, `TEST`, `$SYS`) and their credentials under `.local/nats`; used by `bun run dev` and CI: `bun packages/gateway-ops/scripts/dev-nats.ts`
