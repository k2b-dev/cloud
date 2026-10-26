### A delayed command overrides later navigation

- **What happened:** Resolving another application’s entry point outlives the view that requested it and navigates or reports an obsolete error.
- **Root cause:** A delayed command overrides later navigation.
- **Error class:** A delayed command overrides later navigation.
- **Guard:** Test: Files `history-contact.behavior.test.tsx` delays successful and failed command responses past navigation and disposal; the request uses the workspace navigation signal and suppresses obsolete feedback.
