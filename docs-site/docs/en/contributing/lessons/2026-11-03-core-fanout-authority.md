### Core fan-out repeated authority and app-access work for every target

- **What happened:** Universal search and the dashboard reloaded the person and checked app access once per target app, so their permission cost grew with the number of apps.
- **Root cause:** Each target went through the single-invocation broker, which resolves the issuing authority and runs `canUseApp` for its one target.
- **Error class:** Permission cost grows with the number of apps.
- **Guard:** Search and widget tests compare one and fifteen admitted apps: one authority resolution and no per-target `canUseApp`. An issuer test proves the batch decides with the reloaded authority, so a phone session never reaches an admin-only app.
