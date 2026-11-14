### Check a committed generated file against its sources

- **What happened:** From 7 November, 07:00, the hourly sync of the shared main checkout stopped. The running Fibel had regenerated the chart showcase registry, and the checkout now differed from the committed file, which missed the area, balance and budget examples.
- **Root cause:** A pull request added example files without running `generate.ts`. Nothing compared the committed `registry.generated.ts` with the folder: Fibel and the showcase test rewrite it before they read it, so every check passed on a fresh copy while the committed one stayed stale.
- **Error class:** A committed generated file drifts from its sources when only the tools that regenerate it ever read it.
- **Guard:** The repository rule `showcase-registry` (`bun scripts/check.ts showcase-registry`, `--fix` writes the file) runs the generator in memory and fails when the committed registry differs. `scripts/checks/showcase-registry.test.ts` covers a missing and a removed example, a hand-edited and a missing registry, and the fix.
