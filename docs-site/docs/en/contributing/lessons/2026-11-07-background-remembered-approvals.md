### Background runs never use remembered approvals

- **What happened:** The helper that decides whether a turn may use a person's remembered approvals recognized background runs only by their mandate, not by their background context.
- **Root cause:** The rule "background authority never inherits Always Allow" was expressed through the mandate field alone, while background runs are also marked by their own `background` context.
- **Error class:** An authorization helper keys a policy on one field that usually, but not by construction, accompanies the condition it protects.
- **Guard:** `executor.test.ts` checks that background run configurations, with or without a mandate, get neither remembered nor website approvals, and that interactive turns keep them.
