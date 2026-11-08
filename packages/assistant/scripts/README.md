# Assistant scripts

- `build-extras.ts` — build hook invoked by `packages/cloud/scripts/build.ts` (needs `DIST_DIR`); bundles runner helpers, library chunks and the document stylesheet.
- `test.ts` — runs the package unit tests. Integration tests use the root test runner and explicit `CLOUD_TEST_*` targets.
