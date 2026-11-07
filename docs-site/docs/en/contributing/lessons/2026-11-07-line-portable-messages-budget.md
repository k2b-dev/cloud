### Measure portable chart features at the app-frame boundary

- **What happened:** Forecast drawing and validation grew the Assistant app-frame prelude beyond its previous 306,900-byte budget.
- **Root cause:** The new pure line renderer also imported the complete UI message catalogue just to name an unnamed series.
- **Error class:** Unnecessary dependency growth across an eager bundle boundary.
- **Guard:** Pure SVG fallback labels use a small localization catalogue. Optional detailed line drawing now ships in the offline plugin, while the established base line renderer stays eager. The prelude guard stays at 319,900 bytes. Until the catalog is complete, the coordinator permits a measured chart-module limit plus approximately 1% headroom; #2790 tracks the final catalog total. Core import guards restrict the new catalogue to stdlib localization and continue rejecting Solid and upstream drawing imports.
