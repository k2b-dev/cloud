# Assistant scripts

- `build-extras.ts` — build hook invoked by `packages/cloud/scripts/build.ts` (needs `DIST_DIR`); bundles the assistant browser extras.
- `eval-code-mode.ts` — runs the real Assistant prompt and tool discovery against disposable data services and reports route, timing and app check metrics per case: `bun packages/assistant/scripts/eval-code-mode.ts --case todo`
- `test.ts` — runs the package test suites (server and DOM builds); used by `bun run --cwd packages/assistant test`.
- `test-artifacts.ts` — runs the Assistant integration tests: the artifact service suite on disposable Postgres and rsql containers, every other integration file against the `CLOUD_TEST_*` targets; used by `bun run --cwd packages/assistant test:integration`.
