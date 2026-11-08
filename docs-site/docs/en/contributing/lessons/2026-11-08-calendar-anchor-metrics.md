### Anchor fixed-size calendar text to grid coordinates

- **What happened:** WebKit separated weekday labels from their grid by more than 8px as calendar cells grew. The Assistant phone frame also showed the oldest weeks.
- **Root cause:** Inverse-scaling text around a glyph-relative fill box used engine-dependent bounds. The standalone Assistant wrapper omitted the reversed flex geometry. Tests assumed a positive scroll offset and a fixed intrinsic header width, although reversed scrolling starts at zero and native control metrics differ by engine.
- **Error class:** Responsive SVG transforms and browser-specific geometry assumptions.
- **Guard:** Weekday labels now share the grid's explicit SVG translation anchor, with a fixed 3px offset inside the inverse-scaled group. Core tests verify this structure. Existing browser tests retain the 8px gap limit at 390, 800, 1440 and 1920px and on the Newsletter dashboard. The Assistant test checks both visible newest and off-screen oldest cells. The first-load test compares the real frame to its uncontained intrinsic header in the same engine, then requires identical boxes through mounting and data arrival.
