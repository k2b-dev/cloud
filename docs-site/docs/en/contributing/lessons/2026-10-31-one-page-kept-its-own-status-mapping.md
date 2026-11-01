### The Mail draft review kept its own 403-to-404 mapping

- **What happened:** #2257 gave the draft review page an inline mapping that turned every 403 into 404, while #2263 introduced the shared `pageReadStatus` for all other Mail pages. Both merged on 2026-10-31, so one page followed a different rule: a caller who can read the mailbox but is refused would get "Page not found" there and 403 everywhere else.
- **Root cause:** The two pull requests were built in parallel; the draft page could not use the helper until both had merged.
- **Error class:** A shared rule lands while one consumer still carries a local copy of an older version of it.
- **Guard:** The draft review now uses `pageReadStatus`; `draft-read-page.render.test.ts` checks 404 for a caller who cannot read the mailbox and 403 for one who can.
