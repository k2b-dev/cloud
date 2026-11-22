### Shared ambient declarations replaced a sibling package's dependency types

- **What happened:** A standalone app on `@k2b/cloud` and `@k2b/ssr` 0.23 failed `tsc` with `TS2554` in `@k2b/ssr/src/transform.ts` as soon as its tsconfig included Cloud's shared `ambient.d.ts`.
- **Root cause:** `packages/cloud/src/types/ambient.d.ts` declared `module "@babel/core"` with `typeof import("@babel/types")`. Since `@k2b/cloud` depends on `@babel/parser` 8, consumers resolve `@babel/types` 8, while `@k2b/ssr` is written against Babel 7 and ships `@types/babel__core` 7. The ambient stub replaced those types for every app.
- **Error class:** A declaration file that every app includes overrides a real package's types, so its result depends on whichever major version the consumer happens to resolve.
- **Guard:** The block is gone; the shared file declares only asset modules. `scripts/check-cloud-packed-consumer.ts` now includes the installed `@k2b/cloud/src/types/ambient.d.ts` in its strict consumer typecheck, which fails with `TS2554` on the old file.
