### Setup work and real timers exhausted test deadlines

- **What happened:** The UI example compiler, Assistant live-context test, and PIN lifecycle test exceeded their existing deadlines ([#1872](https://github.com/k2b-dev/cloud/issues/1872), [#1873](https://github.com/k2b-dev/cloud/issues/1873), [#1875](https://github.com/k2b-dev/cloud/issues/1875)).
- **Root cause:** The documentation test checked the whole dependency program before filtering diagnostics; the live-context test included cold module setup and real coalescing delays in its timed assertion; PIN setup and two independent unlock checks shared one test deadline.
- **Error class:** Excessive setup work and wall-clock scheduling in focused tests.
- **Guard:** Compile diagnostics for the example files, initialize the live-context modules in setup, and advance a fake clock across the existing coalescing boundary. Prepare the changed-PIN fixture in setup and check old-PIN rejection and key preservation independently. Preserve all assertions, cryptographic parameters, and existing deadlines.
