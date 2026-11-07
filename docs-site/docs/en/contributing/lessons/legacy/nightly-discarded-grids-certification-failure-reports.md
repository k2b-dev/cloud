### Nightly discarded Grids certification failure reports

- **What happened:** The Grids Nightly job reported a failed phase, but its test names and errors were unavailable after the runner exited.
- **Root cause:** The certification runner wrote full process logs and JUnit reports to a temporary directory; unlike the pull request job, Nightly never uploaded them.
- **Error class:** Failure evidence left on a disposable runner.
- **Guard:** `scripts/nightly-grids-reports.test.ts` checks the shared report path, upload on failure, unique artifact name, and unconditional container cleanup. This repairs evidence retention; it does not identify or fix the failing test.
