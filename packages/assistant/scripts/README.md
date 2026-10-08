# Assistant scripts

- `build-extras.ts` — build hook invoked by `packages/cloud/scripts/build.ts` (needs `DIST_DIR`); bundles the assistant browser extras.
- `eval-code-mode.ts` — lets a real model build the Studio app cases against disposable data services and reports how many passed their first check and were presented without a correction round: `bun packages/assistant/scripts/eval-code-mode.ts --case todo`
- `generate-code-mode-skill.ts` — regenerates the Code Mode skill module from `skills/code-mode`: `bun packages/assistant/scripts/generate-code-mode-skill.ts`
- `test.ts` — runs the package test suites (server and DOM builds); used by `bun run --cwd packages/assistant test`.
- `test-artifacts.ts` — runs the Assistant integration tests: the artifact service suite on disposable Postgres and rsql containers, every other integration file against the `CLOUD_TEST_*` targets; used by `bun run --cwd packages/assistant test:integration`.
