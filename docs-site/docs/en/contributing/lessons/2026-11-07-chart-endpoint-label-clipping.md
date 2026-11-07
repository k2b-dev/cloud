### Exact chart endpoint labels must fit inside the plot

- **What happened:** On a phone, a completed speedtest's exact duration label extended outside the SVG and clipped its unit.
- **Root cause:** The plot's outer padding did not reserve enough space for centered endpoint labels and their units.
- **Error class:** Clipped axis labels on explicit numeric domains.
- **Guard:** Shared renderer tests retain centered labels and half an interval beside exact bounds. Speedtest reserves unit space through public chart padding. Its browser flow checks that every time label stays inside the SVG and adjacent labels do not overlap at phone and desktop widths.
