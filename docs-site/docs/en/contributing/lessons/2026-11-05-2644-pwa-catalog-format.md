### Format the shared PWA catalog before pushing

- **What happened:** The PWA frame and its dependent pull requests failed the repository check on the shared message catalog.
- **Root cause:** A manually wrapped message did not match the formatter output.
- **Error class:** Unverified formatting in a shared stack dependency.
- **Guard:** The `biome` repository check and a successful formatter exit code before pushing.
