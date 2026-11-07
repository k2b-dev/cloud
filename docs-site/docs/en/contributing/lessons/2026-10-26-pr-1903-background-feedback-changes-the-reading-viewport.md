### Background feedback changes the reading viewport

- **What happened:** A conditional error card above the feed changes its position and height.
- **Root cause:** Background feedback changes the reading viewport.
- **Error class:** Background feedback changes the reading viewport
- **Guard:** Tests: Chat focused DOM retry cases require the same composer or read-only status region and feed siblings before and after recovery. Browser geometry remains a separate check.
