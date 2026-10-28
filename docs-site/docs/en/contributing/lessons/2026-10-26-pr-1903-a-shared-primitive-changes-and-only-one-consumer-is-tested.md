### A shared primitive changes and only one consumer is tested

- **What happened:** A UI primitive's timing changes for one app's bug; another app that reads its result synchronously breaks, and only CI notices.
- **Root cause:** A shared primitive changes and only one consumer is tested.
- **Error class:** A shared primitive changes and only one consumer is tested
- **Guard:** Convention: a change in `packages/ui` runs the tests of every package that uses the changed module (search its class or attribute), not only the app that needed the fix.
