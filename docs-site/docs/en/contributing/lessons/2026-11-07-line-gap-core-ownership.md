### Keep detailed line rendering opt-in

- **What happened:** Adding forecast legends and portable paint changed existing charts, and normalizing parity assertions hid those regressions.
- **Root cause:** New rendering behavior ran for every line specification instead of being enabled by an additive option.
- **Error class:** An additive chart feature silently changing saved descriptions.
- **Guard:** The original frozen SVG, screenshot digests and application assertions remain unchanged. Forecasts and annotations opt in to detailed rendering; `legendValues: true` enables it without annotations. The core shares layout and path construction, while existing maxGap descriptions retain their established UI adapter. New forecast tests check gap segmentation within the opted-in core path.

Additional guards freeze three- and five-series drawings from main, including missing and isolated observations and error rows. Forecast tooltips retain their original title and rows before appending bounds. Legend entries identify their source series separately from their palette color and list position.

The limits schema rejects null observations in legacy lines and scatter. Only detailed lines accept null gaps; guards exercise the actual Chat tool schema and verify isolated marks on either side of a gap.
