### Standalone example checks must not rely on root dependencies

- **What happened:** The App-PWA example added a root workspace dependency, causing the dependencies check to fail.
- **Root cause:** The standalone example has its own TypeScript configuration and package boundary, so its tests could not resolve the workspace Cloud package without root hoisting.
- **Error class:** A standalone fixture relies on undeclared workspace dependency resolution.
- **Guard:** The `dependencies` check rejects non-exact root dependencies. The example maps only its public Cloud entry points to the matching workspace exports for TypeScript and Bun; its existing unit and browser tests verify resolution without root hoisting.
