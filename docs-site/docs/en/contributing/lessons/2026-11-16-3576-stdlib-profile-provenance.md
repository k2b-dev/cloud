### Conflict-message dependency upgrades also change document provenance

- **What happened:** PR #3576 failed both its unit shard and Grids certification after upgrading stdlib to 0.33.0. The certification report contained one failure, the same profile provenance assertion as the unit shard.
- **Root cause:** The dependency upgrade changed conflict-message handling, but the DATEV, SEPA and German E-Invoice profiles still recorded stdlib 0.32.0 in their renderer and validator stamps.
- **Error class:** Dependency version drift in artifact provenance.
- **Guard:** The unchanged `packages/grids/src/document-profiles/financial.test.ts` checks renderer and validator stamps for all four stdlib-backed profiles against the installed version. Run this file after every stdlib upgrade, including upgrades unrelated to financial rendering.
