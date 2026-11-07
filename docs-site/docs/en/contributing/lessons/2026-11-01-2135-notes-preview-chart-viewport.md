### Nested preview charts exceeded their image viewport

- **What happened:** A note's chart was cut off at the right edge of its link preview.
- **Root cause:** The generated chart supplied a viewBox without dimensions. Nested in the preview SVG, it inherited the full image viewport.
- **Error class:** Responsive SVG dimensions depend on the embedding context.
- **Guard:** The preview sets the chart's pixel dimensions explicitly. A rendered-PNG regression checks that the chart is present and the right and lower image margins stay white.
