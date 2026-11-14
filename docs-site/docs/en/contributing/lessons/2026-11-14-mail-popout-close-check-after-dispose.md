### A popout's close check ran after the composer was gone

- **What happened:** CI reported "window is not defined" from `MailComposer.tsx` between two tests, right after the popout composer sent a message.
- **Root cause:** After sending, a popout closes its window and checks 100 ms later whether that worked. The timer was never kept, so unmounting the composer did not stop it, and it read `window.closed` before its `disposed` check, after the test environment had removed `window`.
- **Error class:** A timer started by a component that neither ends with the component nor checks its liveness before touching the page.
- **Guard:** The composer keeps the timer and clears it in `onCleanup`, and checks `disposed` first; `MailComposer.behavior.test.tsx` ("a popout that unmounts right after sending runs no close check afterwards") unmounts right after Send and asserts that nothing reads `window.closed` afterwards.
