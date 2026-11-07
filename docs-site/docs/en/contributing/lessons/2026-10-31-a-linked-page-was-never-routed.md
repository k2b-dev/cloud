### The Mail automation log was linked but never routed

- **What happened:** The conversation reader's "why" link on an automation entry and the workspace's "done today" log link pointed to `/app/mail/<mailbox>/automations/log`, but every click opened a 404 (#2259). The page itself had existed since #1981.
- **Root cause:** The page file was added without its `.get(...)` line in `packages/mail/src/frontend/index.ts`, and each link built the address by hand, so no test connected a link to the router.
- **Error class:** A link and its route are written in separate places, and nothing checks that the router serves the address the link produces.
- **Guard:** Both links use `automationLogHref`, and `automation-pages.render.test.ts` requests the addresses it produces (with and without an entry) through the real Mail router and expects the log page; the log page also joins the shared 404/403 tests of the automation pages.
