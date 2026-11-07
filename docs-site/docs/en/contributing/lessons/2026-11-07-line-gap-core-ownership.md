### Line gaps must be owned by the shared renderer

- **What happened:** The UI adapter split long gaps while a direct SVG consumer connected the same observations. Filtering missing values also connected points across a missing observation.
- **Root cause:** Gap handling ran as SVG postprocessing in the UI adapter instead of segmenting the source observations in the shared line renderer.
- **Error class:** Host-dependent rendering caused by implementing data semantics above the shared renderer.
- **Guard:** `chart-line-gaps.test.ts` exercises the core and UI paths for straight, smooth and stepped lines. `line-forecast.test.ts` checks missing observations, forecast bands and isolated points; the browser fixture checks the real consumer adapters.
