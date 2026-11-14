### Dependency upgrades must update document provenance

- **What happened:** Updating stdlib to 0.31.1 failed both the unit shard and Grids certification because financial document profiles still recorded stdlib 0.30.0.
- **Root cause:** The dependency pins changed without updating the hand-maintained renderer and validator version stamps in the DATEV, SEPA and German E-Invoice profiles. These stamps are runtime metadata, not generated fixtures.
- **Error class:** Dependency version drift in artifact provenance.
- **Guard:** `packages/grids/src/document-profiles/financial.test.ts` checks every stdlib-backed profile, including both E-Invoice versions, against the installed stdlib version. Run it against the upgraded dependency when changing the pin.
