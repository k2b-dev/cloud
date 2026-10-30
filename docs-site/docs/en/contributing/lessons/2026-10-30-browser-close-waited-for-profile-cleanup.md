### Closing a dead browser still waited for its profile cleanup

- **What happened:** `pwas/pwa-auth/src/change-sheet.behavior.test.ts` failed with an `afterAll` hook timeout on #2125, which does not touch the PWA. The log said `chromium close did not finish within 2000 ms; killed process group 13155, gone after 2002 ms` (#2132).
- **Root cause:** `killProcessGroup` in `packages/ui/test/browser.ts` killed the browser's process group and saw it gone, then waited the rest of its 2 s budget for Playwright's `kill()`, which also removes the browser profile and is slow on a loaded runner. After the 2 s graceful wait, less than the planned 1 s was left for the rest of the hook, so `server.stop` and removing the test's build directory pushed it past Bun's 5 s.
- **Error class:** Cleanup that is no longer needed for correctness takes up a shared time budget.
- **Guard:** Once the group is gone, `killProcessGroup` waits at most 250 ms for that cleanup and lets it finish in the background. `packages/ui/test/browser.browser.test.ts` kills a real process group whose cleanup never finishes: with the old wait it took 2000 ms, now under 1000 ms.
