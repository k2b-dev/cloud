### A process can vanish between opening and reading its /proc file

- **What happened:** The runner test "C13b SIGKILL of the launcher terminates and reaps its namespace init" failed in CI with `ESRCH: no such process, read` on `/proc/<pid>/stat`, although the init had been reaped exactly as the test expects.
- **Root cause:** The poll treated only `ENOENT` as "the process is gone". When the init is reaped after `open()` succeeded but before `read()`, the kernel reports `ESRCH` instead.
- **Error class:** A liveness poll on `/proc` recognises only one of the two errors that mean "gone".
- **Guard:** `packages/runner/test/jobs.engine.test.ts` treats both `ENOENT` and `ESRCH` as a reaped process. Convention `proc-gone-enoent-or-esrch`: any check that reads `/proc/<pid>/…` to detect a vanished process accepts both codes. Keep the default test budgets.
