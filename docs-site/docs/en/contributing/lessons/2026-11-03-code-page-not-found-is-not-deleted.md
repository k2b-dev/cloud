### A reader's "not found" is not a deletion

- **What happened:** The Code page said a target "was deleted" whenever the target app's reader answered 404.
- **Root cause:** Apps answer "not found" both for a resource that does not exist and for one the person may not read. The page read the status as a deletion signal it never had.
- **Error class:** A status with two meanings is shown as the stronger one.
- **Guard:** `packages/cloud/src/ssr/code-page/CodePage.render.test.tsx` loads a target whose reader answers 404 and asserts it is only `missing`, without name or link, and that the page shows type and ID and never says deleted. `CodePageTarget` no longer has a `deleted` field, so no consumer can claim one.
