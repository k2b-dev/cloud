### Repeated --filter options ran only the last package

- **What happened:** `bun run test --filter packages/a --filter packages/b` ran only `packages/b` and reported a green run.
- **Root cause:** The runner stored `--filter` in a single string, so each occurrence overwrote the previous one.
- **Error class:** Repeated CLI options overwrite earlier selections.
- **Guard:** Tests: `scripts/run-tests.test.ts` checks that parsing retains every filter and selection runs their union once, with exclusions applied before sharding; missing values fail at every occurrence.
