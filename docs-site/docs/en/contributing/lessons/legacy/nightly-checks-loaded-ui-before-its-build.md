### Nightly checks loaded UI before its build

- **What happened:** The Nightly dependencies job stopped before checking dependency policy because Bun could not resolve `@k2b/ui`.
- **Root cause:** The check runner imports all rule modules, including a Markdown consumer of UI; the fresh job installed packages but never built the exported UI files.
- **Error class:** A CI check imports an unbuilt workspace package.
- **Guard:** `scripts/nightly-ui-build.test.ts` requires a UI build before repository checks in each Nightly job.
