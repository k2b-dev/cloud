### Two test clients declared one window global with two types

- **What happened:** The phone head test client (`packages/ui/test/v2-phone-head-actions.client.tsx`, #4373) declared `window.__k2Opened` as a string. A row menu test client that landed on main at the same time declared it as a list of strings. Each branch passed on its own; together the ui typecheck failed (TS2717), so the merge result would have gone red in the queue.
- **Root cause:** Test clients add their globals to the one `Window` interface of their package's typecheck, under short generic names. Two tests that pick the same name clash only once both are on one branch.
- **Error class:** A global name that does not say which test owns it.
- **Guard:** The package typecheck catches such a clash and the merge queue runs it on the merge result, so none reaches main; the convention is that a test client's window global carries the test's name, such as `__k2HeadOpened` or `assistantV2Harness`, never a generic name like `harness` or `searches`.
