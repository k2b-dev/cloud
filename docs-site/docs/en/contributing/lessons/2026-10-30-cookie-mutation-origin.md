### Same-site cookies do not prove a same-origin action

- **What happened:** A page on a sibling origin could submit a simple POST carrying a signed-in Cloud user's session cookie to a state-changing route.
- **Root cause:** Session cookies used `SameSite=Lax`, while application dispatch had no mandatory Origin check. Same-site sibling hosts can send these cookies across origins, including with form, multipart, text and bodyless POSTs.
- **Error class:** Ambient session authority without a mandatory request-origin boundary.
- **Guard:** `session-origin.test.ts`, `session-origin.browser.test.ts`, `define-app.cli.test.ts` and `me-password-sign-out.integration.test.ts` check the platform boundary, real browser form and fetch requests, web/app sessions, WebSocket upgrades, logout, sign-out-others and credential-only exceptions. The runtime checks Origin before every route and removes Cloud session cookies from explicitly sessionless protocol routes.
