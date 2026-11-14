### Browser cleanup mistakes zombies for living processes

- **What happened:** UI tests passed their assertions but failed in afterAll because the browser's process group still existed after SIGKILL (#2871).
- **Root cause:** Signal 0 checks process-group existence, including terminated members awaiting reaping. A regression test reproduces the same cleanup error with a zombie held by a stopped parent; waiting longer cannot make that parent reap it. The CI logs did not record member states, so they cannot prove which processes remained in those runs.
- **Error class:** Resource cleanup mistakes a terminated process awaiting reaping for a living process.
- **Guard:** `packages/ui/scripts/browser-process.test.ts` holds a real Linux zombie until after cleanup and requires success, then verifies that a living orphan remains detectable after its group leader exits and is killed by cleanup. The browser recovery tests assert that no living group member remains. The existing graceful-close and kill budgets stay unchanged.
