### Replicas that booted together failed their setup (#1562)

- **What happened:** Two FAQ replicas migrating a fresh schema together repeatedly left one failing with `23505` on `pg_namespace_nspname_index`. Existing schemas could fail on duplicate constraints or triggers, or concurrent catalog updates ([#1562](https://github.com/k2b-dev/cloud/issues/1562)).
- **Root cause:** `CREATE IF NOT EXISTS` and drop-then-create DDL were safe to repeat, but lifecycle setup ran on every replica without serialization.
- **Error class:** Rerun-safe treated as concurrent-safe startup DDL.
- **Guard:** The platform holds a renewed NATS lease per application during setup. `setup-lock.test.ts` covers waiting, renewal, release, and lease loss. `setup-lock.integration.test.ts` boots two real processes through ten cold and ten warm rounds, checks non-overlapping setup intervals, and kills a holder to verify recovery after lease expiry. The scale harness starts all replicas together, Core first, and requires `RestartCount` 0 after readiness.
