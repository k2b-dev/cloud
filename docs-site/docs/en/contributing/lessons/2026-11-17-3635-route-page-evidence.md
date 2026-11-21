### Response metadata must not change route registration

- **What happened:** Checked page and data routes failed at execution with `code_entrypoints_changed`; documented examples and the isolated runner failed too.
- **Root cause:** The checker added `route.page` as display evidence, but the generated host compared it against the SDK's runtime registration, which has no response metadata. A separate date fixture updated only one of its two snapshots of the same run.
- **Error class:** Derived display evidence included in runtime identity; inconsistent duplicated test snapshots.
- **Guard:** `checker-bundle-source.test.ts` accepts both page flags while rejecting changed method, path, public access and layout. The real Mail/TSX checker tests retain response assertions, and `code-moment.behavior.test.tsx` keeps its exact shared date expectation with consistent snapshots.
