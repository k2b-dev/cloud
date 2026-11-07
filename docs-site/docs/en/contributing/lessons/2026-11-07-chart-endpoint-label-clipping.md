### Exact chart endpoint labels must fit inside the plot

- **What happened:** On a phone, a completed speedtest's exact duration label extended outside the SVG and clipped its unit.
- **Root cause:** Numeric endpoint labels were centred on the plot edge. Moving them inward also requires enough space beside adjacent ticks.
- **Error class:** Clipped axis labels on explicit numeric domains.
- **Guard:** Shared renderer tests require inward endpoint anchors and a full regular interval beside exact bounds. The speedtest browser flow checks that every time label stays inside the SVG and adjacent labels do not overlap at phone and desktop widths.
