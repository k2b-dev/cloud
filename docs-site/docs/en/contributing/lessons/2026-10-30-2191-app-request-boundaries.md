### App request boundaries preserve budgets, errors, and identity

- **What happened:** Signed body reads lacked an absolute deadline, authentication errors lost their meaning in capability clients, and keyless lifecycle calls omitted the app identity header.
- **Root cause:** The shared transport did not apply the request budget, capability error envelope, and legacy owner identity contract together.
- **Error class:** Incomplete contracts at transport boundaries.
- **Guard:** `authenticate-app-request.test.ts` checks body deadlines, cancellation, proof preflight, and parsed admission errors; `app-request-consumers.test.ts` checks Chat deferrals and permanent Mail failures; `app-request.test.ts` and `identity-mandates.test.ts` check identity headers and keyless lifecycle calls.
