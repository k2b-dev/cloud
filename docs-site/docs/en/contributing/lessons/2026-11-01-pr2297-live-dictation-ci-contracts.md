### Extend provider choices without shifting existing keyboard selections

- **What happened:** Adding live dictation changed the provider selected by Home and ArrowRight, broke the custom-header flow, and failed integration and documentation checks in CI.
- **Root cause:** The new provider was prepended to the choice list. A subprocess imported files relative to the runner's working directory, and the new guide lacked a navigation title and reused an existing section order.
- **Error class:** Extending a list or test fixture changes implicit ordering or working-directory assumptions.
- **Guard:** The existing Home/custom-header and phone ArrowRight tests in `AiReview.browser.test.ts` preserve provider behavior. The independent-session test in `live-dictation.integration.test.ts` now starts its subprocess outside the repository root with absolute imports. `bun run --cwd docs-site check:docs` checks navigation metadata and unique section orders.
