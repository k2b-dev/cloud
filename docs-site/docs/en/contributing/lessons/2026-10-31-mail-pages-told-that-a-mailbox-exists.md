### Mail pages answered 403 for a mailbox the caller could not read

- **What happened:** An unknown mailbox or draft address answered 404, but an existing one the caller could not read answered 403 on the mailbox, Compose, automation, and draft review pages. The difference told a signed-in person that the address exists. Found in the back-link work on 2026-10-31 (#2257); mailbox IDs are random, so the risk was low.
- **Root cause:** Each page passed the service's refusal status through (`ssr.error(c, result.error.status)`), and the services answer a refused read with 403.
- **Error class:** A page reveals that a resource exists by answering a refused read differently from a missing one.
- **Guard:** Mail pages map a refused read through one helper, `pageReadStatus` in `ssr-public-boundary.ts` (403 becomes 404, every other status stays). Render tests cover each page class: the mailbox page, both Compose pages, every automation page, and the draft review; `ssr-public-boundary.test.ts` covers the mapping. A Compose reader without write access still gets 403, because the mailbox is visible to them.
