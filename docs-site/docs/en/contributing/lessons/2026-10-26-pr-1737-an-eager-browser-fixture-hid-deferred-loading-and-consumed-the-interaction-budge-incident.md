### An eager browser fixture hid deferred loading and consumed the interaction budget

- **What happened:** The Notebook table-source recovery test exceeded its unchanged five-second deadline in WebKit before completing the second edit.
- **Root cause:** Its IIFE parsed deferred diagram modules on every navigation. The 16.5 MB script cost about 2.7 seconds to open; the production-style split build reduced the entry script to 2.4 MB and the measured opening to 1.2 seconds.
- **Error class:** A browser fixture whose module-loading behavior differs from the application.
- **Guard:** The fixture serves the source build's split ESM artifacts with production conditions. The original source-recovery flow keeps its deadline and assertions; code-paste coverage waits for the actual deferred input before checking the entire fenced text and indentation.
