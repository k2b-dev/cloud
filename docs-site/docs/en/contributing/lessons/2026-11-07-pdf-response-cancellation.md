### Cancel a pending PDF response read when its deadline ends

- **What happened:** A stalled response stream could keep PDF processing waiting after the caller cancelled, holding renderer admission.
- **Root cause:** The transport checked the signal before awaiting a response chunk, but did not cancel a pending read or check the signal after the read completed.
- **Error class:** Cancellation checks outside a blocking await do not interrupt that await.
- **Guard:** The `abort cancels a stalled response reader and releases shared admission` test in `packages/cloud/src/services/pdf/tools.test.ts` cancels a response that never produces a chunk and verifies that the reader and renderer place are released.
