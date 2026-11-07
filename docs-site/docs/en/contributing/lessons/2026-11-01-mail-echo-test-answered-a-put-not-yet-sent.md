### A Mail draft test answered a save that was not sent yet

- **What happened:** The merge queue for #2309 failed on `mail-draft-session.behavior.test.tsx` ("live echo of an own save stays quiet …, including a pending save"). The test timed out after 5 seconds; the same test had passed in earlier merge groups.
- **Root cause:** `persist()` shows "saving" and then hashes the last saved and the new content with native SHA-256 before it sends the PUT. The test flushed fake timers and microtasks once and then answered the PUT through an optional callback. Under CI load the hashes were still running, so the callback was not set yet, the answer was skipped, and the save never finished.
- **Error class:** State sampled before it settled: a test answers a request that an asynchronous step has not sent yet, and an optional call hides the miss.
- **Guard:** The test now waits for the PUT itself through a promise that the fake server resolves, and answers it without an optional call. The 2026-11-01 Mail autosave lesson already states that flushes do not finish a native digest.
