### The draft review's back link said "Mail" but led to the mailbox

- **What happened:** The read-only draft review (`/app/mail/<mailbox>/drafts/<draftId>`) showed "‹ Mail" above the subject, but the link opened the mailbox, not the Mail app (#2242). It is the page's only way back, so the link stays; its name was wrong.
- **Root cause:** The page titled the level above with the generic `breadcrumbMail` string, because it never loaded the mailbox and had no name to show.
- **Error class:** A way-up level names a different place than its link leads to.
- **Guard:** The page reads the mailbox through the permission-aware `mailboxes.getMailbox` together with the draft and names the level with the mailbox. A refused read (403) answers 404, as for an unknown address, so the page never tells that a mailbox or draft exists; `draft-read-page.render.test.ts` checks the published trail names the mailbox and that a caller refused by the mailbox or draft read gets 404 without the mailbox name or the draft.
