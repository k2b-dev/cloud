### A hand-kept component count took pull requests out of the merge queue

- **What happened:** On 2026-11-07 and 2026-11-08, #2845, #2855, and #2798 left the merge queue because the `docs` job reported "Stale portable component count: expected N+1, received N", although each pull request was green on its own.
- **Root cause:** `portableUiComponentCount` in `docs-site/src/ui/catalog.ts` was a number edited by hand. Two branches that each added a component raised it to the same value; Git merged the identical lines without a conflict, so one increment was lost. The check from the 2026-10-27 lesson caught it only after the merge, in the queue.
- **Error class:** A hand-maintained copy of derived metadata that parallel branches edit to the same value.
- **Guard:** The count is no longer stored: `docs-site/src/ui/portable-components.ts` counts the component exports of `@k2b/ui` itself, and the catalog page shows that value, so there is nothing left to keep in step.
