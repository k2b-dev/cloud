### Keep optional line drawing out of the common app prelude

- **What happened:** Forecast drawing made every app frame exceed its prelude budget, and the shared inspector's source bundle exceeded its unchanged size guard by 18 bytes.
- **Root cause:** Common and detailed line charts used the same eagerly imported renderer. A duplicated tooltip-title construction also consumed part of the inspector's small budget.
- **Error class:** Optional behavior crosses an eager bundle boundary.
- **Guard:** The app runtime uses the unchanged base line renderer for ordinary descriptions and routes opted-in lines through the offline plugin, forwarding locale. Asset tests assert that forecast, negative-zone and threshold drawing are absent from the prelude and that forecast drawing is in the chart module. Existing byte-level parity stays strict; the three- and five-series oracle also checks the base renderer. A delayed-plugin browser fixture checks ordinary eager lines and opted-in loading at desktop and phone widths. Both size limits stay unchanged, so an oversized offline module continues to block merging. The inspector reuses its tooltip-title construction without changing output.
