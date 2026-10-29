### Audit foreign administrator history reads once per scope

- **What happened:** Snapshot projection bypassed storage reads, which previously owned the administrative read audit. The unavailable notice depended on a selected POSIX filter.
- **Root cause:** Administrators could read foreign history snapshots without the trace written by administrative storage reads; a mixed overview also silently omitted POSIX areas.
- **Error class:** Administrators could read foreign history snapshots without the trace written by administrative storage reads; a mixed overview also silently omitted POSIX areas.
- **Guard:** Integration tests verify atomic activity/audit records once per foreign history page with all distinct returned foreign bindings, no writes for filtered-out rows, rollback on audit failure, and no audit for ordinary own reads. Reader tests cover item, batch, chain and share scopes. Browser and behavior tests cover mixed-area guidance in German and English at phone and desktop widths; POSIX-only overviews show a single unavailable notice. Evidence: Audit at the history request boundary before exposing a foreign snapshot. Explain excluded areas persistently in the overall view.
