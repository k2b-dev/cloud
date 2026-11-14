### Sankey long labels

- **Error class:** Responsive SVG geometry and label fitting.
- **What happened:** Long node names lost useful words despite having enough height for two lines.
- **Root cause:** Single-line node captions discarded useful words even when the node had room for a second line.
- **Guard:** Core tests cover measured word wrapping and ellipsis. The browser guard checks complete SVG titles and tooltips, two text lines, natural glyphs and drawing bounds on phone and desktop.
