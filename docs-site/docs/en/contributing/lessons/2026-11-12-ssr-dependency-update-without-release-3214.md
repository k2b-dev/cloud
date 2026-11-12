### A dependency update changed a published package without releasing it

- **What happened:** The release PR for Cloud 0.74 failed the packed consumer check with "@k2b/ssr@0.21.1 source changed without a version bump".
- **Root cause:** The `chore(deps)` update #3154 moved the runtime dependency `babel-preset-solid` of `@k2b/ssr` from 1.9.15 to 1.9.16. A `chore` commit does not make release-please release a package, so `@k2b/ssr` kept its published version with changed contents.
- **Error class:** A non-releasing commit type changes what a published package ships.
- **Guard:** The packed consumer check in the release PR (`scripts/fixtures/packed-consumer-pins.ts`) blocks the release; the fix is a scoped `fix(<package>)` commit, never a manual version edit.
