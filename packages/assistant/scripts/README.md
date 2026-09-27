# Assistant scripts

- `build-extras.ts` — build hook invoked by `packages/cloud/scripts/build.ts` (needs `DIST_DIR`); bundles the assistant browser extras.
- `eval-code-mode.ts` — evaluates Code Mode with the configured AI model against disposable data services: `bun packages/assistant/scripts/eval-code-mode.ts --files ./eval-csvs`
- `generate-code-mode-skill.ts` — regenerates the Code Mode skill module from `skills/code-mode`: `bun packages/assistant/scripts/generate-code-mode-skill.ts`
- `test.ts` — runs the package test suites (server and DOM builds); used by `bun run --cwd packages/assistant test`.
- `test-artifacts.ts` — runs the Assistant integration tests: the artifact service suite on disposable Postgres and rsql containers, every other integration file against the `CLOUD_TEST_*` targets; used by `bun run --cwd packages/assistant test:integration`.
