### Code run details describe effects in words

- **What happened:** Expanding a Code run showed the module as input, and its approval card named Cloud instead of the target application.
- **Root cause:** One-off Code runs used generic tool details. Relayed approvals copied the review but omitted the target application's presentation.
- **Error class:** Internal execution data reused as reader-facing details, with target identity lost at a relay boundary.
- **Guard:** `public-projection.test.ts` and `public-tool-input.test.ts` reject source in public reads and live details. `code-run-details.render.test.tsx` checks descriptions in German and English. `executor.integration.test.ts` checks target-app presentation and its durable history; the admin browser test retains the dedicated source field.
