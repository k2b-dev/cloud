### A quiet IMAP listener rewrote its health row about eleven times a minute

- **What happened:** Every lease renewal of a connected IMAP push listener wrote its unchanged health row. A quiet listener wrote it 55 times in five minutes, although nothing reads its heartbeat time more precisely than to the minute.
- **Root cause:** The health heartbeat was tied to the lease renewal cadence instead of to state changes.
- **Error class:** Write amplification from unchanged background state.
- **Guard:** `imap-push-runtime.test.ts` ("a quiet listener writes its unchanged health at most once a minute") allows at most five writes in five quiet minutes. State changes are still written at once. The test fails without the fix.
