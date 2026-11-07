### Published Cloud imports an export missing from its pinned UI

- **What happened:** Standalone apps using `@k2b/cloud` 0.35.0 from `cloud-v0.42.0` failed typechecking and bundling because `@k2b/ui` 0.25.0 lacked `prefersReducedMotion` ([#1221](https://github.com/k2b-dev/cloud/issues/1221)).
- **Root cause:** The release PR was not refreshed after #1208 merged, so it left UI unbumped. Cloud imported the new export but pinned the already published UI version. Workspace links and the packed check's unconditional workspace tarball overrides hid the mismatch.
- **Error class:** Workspace-only export.
- **Guard:** Check: `packed` runs with `--release` on the release PR and in the merge queue, using npm for already published sibling pins and failing when npm is unreachable. Test: `packed-consumer-pins.test.ts` checks published pins, unpublished release versions, invalid pins, and registry failures. Convention: refresh the release PR after the last feature PR merges and verify its parent against `origin/main` before merging.
