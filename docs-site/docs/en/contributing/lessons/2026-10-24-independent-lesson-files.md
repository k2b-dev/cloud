### Independent fixes conflicted in the lessons page

- **What happened:** Unrelated fix PRs inserted lessons at the same table header, so merging one made the others conflict and repeated CI work.
- **Root cause:** Every fix edited one shared source file at the same insertion point.
- **Error class:** Independent append-only records share a Git merge conflict boundary.
- **Guard:** Each PR adds its own dated Markdown file. The documentation check rejects inline entries in the shared page; `lessons.test.ts` merges independent additions in Git and verifies that Fibel renders and indexes both without changing that page.
