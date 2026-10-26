### Shared rows import the enclosing view

- **What happened:** The activity list and its search results form an import cycle by sharing row helpers through the enclosing view.
- **Root cause:** Two composed views import each other's runtime components.
- **Error class:** Two composed views import each other's runtime components.
- **Guard:** Shared history rows live in `history-rows.tsx`; the `cycles --apps` repository rule rejects runtime cycles. The existing history behavior and browser suites cover both consumers.
