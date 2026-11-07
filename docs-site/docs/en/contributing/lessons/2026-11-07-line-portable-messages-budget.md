### Measure portable chart features at the app-frame boundary

- **What happened:** Forecast drawing and validation grew the Assistant app-frame prelude beyond its previous 306,900-byte budget.
- **Root cause:** The new pure line renderer also imported the complete UI message catalogue just to name an unnamed series.
- **Error class:** Unnecessary dependency growth combined with an outdated feature budget.
- **Guard:** Pure SVG fallback labels use a small localization catalogue. This reduced the prelude from 319,128 to 315,402 bytes. The app-frame test checks the forecast, negative region, threshold and marker are present, with a measured 325,000-byte ceiling. Core import guards restrict the new catalogue to stdlib localization and continue rejecting Solid and upstream drawing imports.
