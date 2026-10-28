### Launcher migrations left the orchestration expectations behind

- **What happened:** Unit and integration jobs failed in the root runner's browser discovery test after three Assistant artifact suites adopted the shared launcher.
- **Root cause:** Commit `4198049da` intentionally moved `context`, `project-apps`, and `workspace` from direct Google Chrome launches to `launchBrowser()` so they could use the shared page-error collector. Browser discovery correctly included them, but its test still asserted that `workspace` was excluded.
- **Error class:** A launcher migration changed test execution ownership without updating the orchestration contract test.
- **Guard:** `scripts/run-tests.test.ts` asserts that all three migrated suites run as separate browser-gate processes, while the remaining direct Google Chrome suites stay excluded. Verify discovery alongside the affected browser suites when changing their launcher.
