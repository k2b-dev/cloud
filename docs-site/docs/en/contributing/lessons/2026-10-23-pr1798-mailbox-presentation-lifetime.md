### Retained Mail panes kept work from the previous mailbox

- **What happened:** Switching mailboxes could retain selection, search, filters, reader state, scroll and pending callbacks from the previous mailbox.
- **Root cause:** Retaining presentation also retained mailbox-owned state and pending work; checking only the mailbox ID accepted stale A→B→A completions.
- **Error class:** Presentation lifetime mistaken for mailbox lifetime.
- **Guard:** Tests: Mail `MailWorkspace.mailbox-switch.behavior.test.tsx` and the mailbox section of `mail-shell.browser-suite.ts`, run by `mail-shell-mailboxes.browser.test.ts`, retain pane identity while clearing selection, reader, search, filters and scroll. List and Reader behavior guards reject earlier generations after A→B→A.
