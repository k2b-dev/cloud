### Observe the promise a browser API rejects on purpose

- **What happened:** Skipped view transitions appeared as browser errors during navigation.
- **Root cause:** Navigation discarded a view-transition handle whose `ready` promise rejects when skipped.
- **Error class:** unhandled rejection from a platform promise. `@k2b/ssr` nav started a view transition and dropped its handle. When a newer navigation skipped the transition, Chromium rejected its `ready` promise with "AbortError: Transition was skipped", and pages reported it as an error (seen in Chat's personal list browser test).
- **Guard:** nav catches `ready` and leaves `updateCallbackDone` alone, so the navigation's own errors still surface. `packages/ssr/test/unit/nav.test.ts` fails on an unhandled rejection from a skipped transition.
