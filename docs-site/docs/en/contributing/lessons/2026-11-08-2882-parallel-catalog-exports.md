### Parallel component additions left the catalog total behind

- **What happened:** The documentation gate reported 192 portable component exports against a catalog total of 191 after the main sync.
- **Root cause:** Main added `DashboardFrame` while feat/code added `CodeDiff`; both branches independently changed the total from 190 to 191, so Git merged the identical edits without adding both increments.
- **Error class:** Derived metadata drift across a conflict-free merge.
- **Guard:** `docs-site/scripts/check-ui-catalog.ts` derives the expected total from runtime exports and checks component coverage. Run `bun run --cwd docs-site check:ui-catalog` after merging UI exports from parallel branches.
