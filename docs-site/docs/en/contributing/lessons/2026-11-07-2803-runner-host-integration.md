### Execution host migrations must update lifecycle fixtures

- **What happened:** The detached-call integration test returned a capability-authority error after chat scripts moved to the Code runner.
- **Root cause:** The disposable Assistant fixture still expected a local Chromium script host. It provided neither a Core runner mailbox nor a continuation for allocating runner jobs. Its replacement engine also needed to observe cancellation when the test deliberately left a script pending.
- **Error class:** An execution transport changes while a lifecycle integration fixture still assumes the old host.
- **Guard:** The server-owned code integration test now uses the real Runner dispatch and compiler fixture, counts starts during concurrent detached polls, and verifies that losing the host never starts another execution. The focused runner-host test also closes a script that reports progress and never finishes, retaining the original script error when cancellation drains the fixture.
