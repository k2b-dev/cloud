### Registry owns catalog retention

- **What happened:** Removing periodic Help and Skill writes would let the previous six-minute cleanup delete catalogs belonging to healthy apps.
- **Root cause:** Catalog retention used `last_seen_at` as a second app-liveness clock even though the observed app registry already owns liveness.
- **Error class:** Removing periodic writes without migrating consumers that depend on their timestamps.
- **Guard:** `catalog-publication.test.ts` counts startup and changed-hash writes for 5 and 20 apps over 60 frozen-clock heartbeat rounds. `app-catalogs.test.ts` verifies zero extra storage passes for lease renewals. `app-catalog-store.integration.test.ts` protects healthy catalogs with old timestamps, accepts 0.55.0 renewal statements without duplication, cancels deletion on return, and deletes removed catalogs after one day.
