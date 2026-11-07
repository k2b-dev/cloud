### The runner reported a stopped suite before its killed descendants were gone

- **What happened:** `deadline cleanup also stops descendants that start a separate session` in `scripts/run-tests.test.ts` saw the detached descendant still alive after the runner had returned, in CI for Notes PR #2127 (#2208). The whole test took 538 ms with its 500 ms budget, so the descendant had started well before the deadline and was among the recorded processes.
- **Root cause:** After the deadline, `runTestCommand` sent SIGKILL to the recorded descendants and rejected at once. A signal is delivered, not awaited: a process can still run for a moment after `kill()` returns, longer on a loaded runner. The test checked liveness right after the runner exited and could see the dying process.
- **Error class:** Cleanup counts a signal as done when it is sent, not when the process has exited.
- **Guard:** After SIGKILL, `runTestCommand` waits until every recorded descendant has exited (a zombie counts as gone, PID and start time must match), for at most 2 s, checking every 25 ms. A descendant still running after that is named in the error, so a missed process is reported instead of left behind.
