### Leave a real glyph gap between average rows

- **What happened:** The bubble chart's unweighted-average caption touched its value row in WebKit.
- **Root cause:** Both use 11px text, but their 14px baseline spacing exactly matched WebKit's glyph bounds, leaving no gap.
- **Error class:** SVG text spacing inferred from font size rather than rendered glyph bounds.
- **Guard:** The caption and value baselines are 18px apart, and their responsive offsets preserve that distance in pixels. The unchanged browser guard requires a real gap across narrow and short drawings; a core test checks both baseline positions.
