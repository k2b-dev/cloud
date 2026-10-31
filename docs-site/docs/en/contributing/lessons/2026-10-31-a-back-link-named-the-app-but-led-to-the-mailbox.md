### The draft review's back link said "Mail" but led to the mailbox

- **What happened:** The read-only draft review (`/app/mail/<mailbox>/drafts/<draftId>`) showed "‹ Mail" above the subject, but the link opened the mailbox, not the Mail app (#2242). It is the page's only way back, so the link stays; its name was wrong.
- **Root cause:** The page titled the level above with the generic `breadcrumbMail` string, because it never loaded the mailbox and had no name to show.
- **Error class:** A way-up level names a different place than its link leads to.
- **Guard:** The page reads the mailbox through the permission-aware `mailboxes.getMailbox` together with the draft and names the level with the mailbox; `draft-read-page.render.test.ts` checks the published trail names the mailbox and that a caller without access to the mailbox gets 404 without its name or the draft.
