### A chat guide links to an absent upgrade section

- **What happened:** The Chat system-conversation guide linked to a missing “Chat mentions and For you” heading, so the documentation CI job failed.
- **Root cause:** The guide retained a cross-page fragment link although the merged build-and-deploy guide had no matching section.
- **Error class:** A documentation link outlives its destination heading
- **Guard:** `docs-site/scripts/check-documentation.ts` validates internal links and heading anchors in `check:docs`, which runs in the CI documentation gate. The guide now names the feed directly.
