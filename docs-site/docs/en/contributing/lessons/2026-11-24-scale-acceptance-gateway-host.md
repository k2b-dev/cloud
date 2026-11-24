### The scale acceptance reached the gateway under a host it no longer serves

- **What happened:** From 31 October, the nightly `scale-acceptance` job failed every night with `Core admin route timed out after 60000 ms: GET /api/openapi.json: expected 2xx, got 421: Misdirected Request`. Behind it, a second failure waited: the `up` that starts Mail, Chat and Notebooks scaled Core back to one replica, so the run could never reach its cross-replica checks.
- **Root cause:** Since #2193 the gateway answers a host other than the Cloud host with 421. The harness reached the gateway on its published loopback port without naming the Cloud host. Its later `docker compose up` calls also reconciled the `app-core` dependency to the scale in the Compose file.
- **Error class:** A nightly-only harness reaches a service differently from production, so a stricter production contract breaks it unnoticed.
- **Guard:** `scripts/scale-acceptance.test.ts` runs in every pull request and checks the harness's gateway host against the gateway's own `decideHost`. The follow-up `up` calls pass `--no-deps`.
