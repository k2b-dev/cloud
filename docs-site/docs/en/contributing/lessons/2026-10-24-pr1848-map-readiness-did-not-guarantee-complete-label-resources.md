### Map readiness did not guarantee complete label resources

- **What happened:** A failed glyph download or missing vector tile could still reach MapLibre's idle state with substituted labels or an incomplete basemap.
- **Root cause:** MapLibre 6 catches glyph transport and PBF decoding failures inside its glyph manager and suppresses HTTP 404 tile errors, without a map error event.
- **Error class:** Renderer fallback mistaken for complete export resources.
- **Guard:** MapView's per-map resource protocol validates glyph PBFs and reports failed glyph and tile downloads explicitly. Synthetic vector browser tests require failed glyph requests and HTTP 404/500 tiles to reject capture, retain retry, and recover before a real raster succeeds.
