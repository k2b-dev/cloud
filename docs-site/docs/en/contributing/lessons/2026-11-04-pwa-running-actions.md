### Hold app updates while actions run

- **What happened:** Returning to the Cloud app after a release could reload the page while a write, upload, or answer was still running.
- **Root cause:** The update runtime checked text and dialogs but had no shared signal for in-flight platform actions.
- **Error class:** Automatic navigation ignores active work.
- **Guard:** PwaRuntime behavior tests cover pending and concurrent writes, failed requests, non-blocking GET reads, and the next safe foreground reload; AI controller and provider-upload tests cover their longer lifetimes.
