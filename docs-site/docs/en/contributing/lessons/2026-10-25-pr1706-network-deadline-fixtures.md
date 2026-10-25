### Observe cancellation at the intended phase

- **What happened:** Network fixture tests could report an expected deadline as an unhandled rejection or expire before reaching their body-read assertion on a busy runner.
- **Root cause:** One fixture waited for connection progress before observing rejection. Another started its body-read deadline before connection setup finished.
- **Error class:** An asynchronous test observes a failure too late or starts a phase-specific deadline in an earlier phase.
- **Guard:** The stalled-connection cases in `fetch-file-tool.test.ts` record the outcome immediately and still verify cancellation, destruction and disconnection. The slow-body case in `allowed-network-fetch.test.ts` starts its unchanged 80 ms deadline after headers arrive and checks the original timeout error. Production code and test deadlines remain unchanged.
