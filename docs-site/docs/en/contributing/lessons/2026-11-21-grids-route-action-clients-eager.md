### The Grids table page carried the Assistant client and the search preview renderer up front

- **What happened:** Merging `main` into `feat/code` (sync 69) pushed the Grids route island to 835,051 B Brotli for
  English and 852,918 B for German, above its 828,416 B eager budget; `main` alone measured 794,834 B and 811,955 B.
- **Root cause:** Two modules that serve one action each reached the route through static imports. The query
  page imported `launchAssistant` from `@k2b/cloud/ai/browser`, whose exports carry chart, message and view-block
  code with top-level schemas that tree shaking keeps. The resource picker's `CloudResourceSearch` imported
  `BlockTree` for the search preview, together with its chart and block action modules. `feat/code` made both
  paths larger.
- **Error class:** An action-only client or a renderer that only appears after a request is imported statically, so
  every page that can reach the action carries the code.
- **Guard:** `GridsRoute.bundle.test.ts` keeps the eager budget and now also expects `ai/browser.ts` and
  `BlockTree.tsx` among the on-demand inputs only.
