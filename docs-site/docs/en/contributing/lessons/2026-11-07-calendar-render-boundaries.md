### Verify calendar examples and scrolled inspection at the consuming boundary

- **What happened:** The calendar documentation demo used unsupported card props. Invalid locales and inherited scroll direction could also break rendering or inspection text.
- **Root cause:** The demo was checked as prose without the consuming site's typecheck, and the browser fixture did not exercise a real theme or tooltip coordinates after scrolling.
- **Error class:** Untested consuming types and scroll presentation leaking into content.
- **Guard:** The documentation typecheck covers the demo. Calendar model tests reject invalid locales; its browser test measures the active anchor after scrolling, selected outlines, real chart boxes and dark text.
