### Exact chart endpoint labels must fit inside the plot

- **What happened:** On a phone, a completed speedtest's exact duration label extended outside the SVG and clipped its unit.
- **Root cause:** Centered endpoint labels extended beyond the compact plot. Applying new anchors and tick spacing globally also changed existing consumers.
- **Error class:** Clipped axis labels on explicit numeric domains.
- **Guard:** Shared renderer tests retain the original ticks and centered labels by default. Speedtest explicitly enables `insetEndpointLabels`; its browser flow checks that every time label stays inside the SVG and adjacent labels do not overlap at phone and desktop widths.
