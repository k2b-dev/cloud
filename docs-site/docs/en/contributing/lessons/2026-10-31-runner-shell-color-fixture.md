### Shell contrast fixtures follow HTTP applications

- **What happened:** The app-color unit test failed with ENOENT while reading the runner's nonexistent shell declaration, before reaching any contrast assertion.
- **Root cause:** The fixture used the deployment application set, which also contains outbound workers without a `src/config.ts` or appearance. The appearance contract is optional.
- **Error class:** A presentation fixture assumes every deployable application owns an HTTP shell.
- **Guard:** The contrast fixture uses the existing workspace-derived `httpAppIds()` set. It still reads every HTTP application's declaration and checks all declared accents and edge colors against the same AA thresholds. The runner remains in the deployment/image set without acquiring a dummy UI accent.
