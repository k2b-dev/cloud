### Reserve space between treemap glyph lines across engines

- **What happened:** A small treemap card passed Chromium but its name and value overlapped in WebKit.
- **Root cause:** The shared responsive CSS preserves text size, but SVG baseline offsets still shrank with the card. WebKit's taller glyph boxes exposed the collision.
- **Error class:** Text layout based on a single browser's font metrics.
- **Guard:** Render the name and value as independent text elements, keep the browser assertion on their real bounds, and reserve a 20px baseline step that stays in CSS pixels, with enough cell height for both lines. A renderer test guards the spacing and suppresses both lines when the cell is too short.

The Pulse catalog renderer also preserves Pareto's measure-label tuple instead of replacing it with inspector labels. Pulse's typecheck guards that discriminated contract at its real JSX caller.
