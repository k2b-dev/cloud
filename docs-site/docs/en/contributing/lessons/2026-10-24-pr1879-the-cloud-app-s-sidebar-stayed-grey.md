### The Cloud app's sidebar stayed grey

- **What happened:** On 16.10. the web's sidebar became white with a tinted selection; the Cloud app's sidebar on iPads and monitors stayed grey with a plain selection.
- **Root cause:** `MobileShell.Sidebar` has its own surface and selection styles, which the change to the web shell did not reach.
- **Error class:** A second navigation surface misses a shared design rule.
- **Guard:** The wide MobileShell browser test compares the sidebar with the page's surface and its open row with the web's selection tint, in light and dark, in Chromium and WebKit.
