### Provider reader rules and continuation drift

- **What happened:** Uppercase principal UUIDs lost readability, invalid account-category presentation settings broke reader checks, and changing the container page limit repeated or skipped Spaces.
- **Root cause:** Platform admission and provider readers separately implemented current-account rules. The provider decoded unrelated settings and compared UUID strings without normalization. Container listing reused a page-number cursor whose position depended on the new limit.
- **Error class:** Duplicated account rules and continuation state tied to page size.
- **Guard:** `packages/cloud/src/_internal/resource-principals.test.ts` verifies delegation to the shared resolver; `packages/spaces/src/resource-readers.integration.test.ts` covers uppercase accounts and corrupt presentation settings; `packages/spaces/src/capabilities.test.ts` changes the container page limit while continuing.
