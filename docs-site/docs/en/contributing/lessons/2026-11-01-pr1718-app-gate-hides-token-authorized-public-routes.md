### A new application gate hid token-authorized public routes

- **What happened:** Published dashboard links redirected to the sign-in page after the application access rollout.
- **Root cause:** The application gate ran before the token-authorized routes, and their paths were missing from the declared public routes.
- **Error class:** A new application gate hides token-authorized public routes.
- **Guard:** Test: Pulse `public-dashboard.render.test.tsx` mounts the real application gate before the SSR and API routes, checks publication and revocation responses, and rejects private neighboring paths.
