### Keep SVG fallbacks aligned with the base stylesheet

- **What happened:** Area charts used different colors in PDF and hosts without chart CSS. The existing palette guard failed in both UI and unit CI jobs.
- **Root cause:** The renderer retained an older literal palette, including a red fourth color, while `base.css` defines blue, green, amber, violet, pink, cyan, lime and orange.
- **Error class:** SVG presentation fallbacks drift from the shared theme tokens.
- **Guard:** The unchanged `area.test.ts` test reads all eight colors from the actual base stylesheet and requires their exact fallback strings in both SVG strokes and fills. Restore the renderer literals rather than changing the guard or its expectations. Ordinary line rendering remains unchanged.
