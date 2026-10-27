### New controls left the catalog's component count behind

- **What happened:** The documentation check failed after the #1854 merge: the portable catalog reported 157 components while the package exported 159.
- **Root cause:** Both branches independently added two component exports and raised the count from 155 to 157. Git merged the identical counter edits without a conflict, even though the combined exports totalled 159.
- **Error class:** Derived metadata drift: identical counter edits on parallel branches merged without accounting for both additions.
- **Guard:** `docs-site/scripts/check-ui-catalog.ts` compares the recorded count with the runtime component exports. Run `bun run --cwd docs-site check:ui-catalog` when merging changes to those exports.
