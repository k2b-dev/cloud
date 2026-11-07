### Calendar geometry must fit the panel before mounting

- **What happened:** The Newsletter calendar used only part of its panel width and left an empty band below its seven rows.
- **Root cause:** Cell size came from a fixed logical height, while a second fixed host height scaled the complete SVG down. Its intrinsic width could not grow with the panel.
- **Error class:** Conflicting intrinsic and host geometry in responsive visualizations.
- **Guard:** Calendar layout tests bound the minimum and maximum square cell sizes and derive the height from the content. The calendar panel browser test measures the actual explorer and viewport at 390, 800, 1440 and 1920 pixels, compares server and first client SVG, and keeps the same boxes through loading, empty, error, retry, stale and table states. Existing interaction and locale parity tests remain active.
