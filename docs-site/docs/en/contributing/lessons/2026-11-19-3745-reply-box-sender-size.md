### The reply box's sender trigger was body-sized and hid the hint in the recipients field

- **What happened:** With two or more sender identities, the reply box head showed "from Support ⌄" in body size beside 0.75 rem labels. The wider trigger squeezed the recipients field until its hint read "Add recipie".
- **Root cause:** `IdentitySwitcher` in `MailComposer.tsx` carries `text-sm` for the composer page. The compose window head overrode it in #3737 (`.mail-compose-window-sender`), the reply box head did not.
- **Error class:** A shared control placed into several heads takes one head's size unless every placement sets its own.
- **Guard:** `mail-shell.browser-suite.ts` (drafts) opens a conversation with two senders and requires the reply box's sender to read at the size of Cc and Bcc beside it and the hint of the recipients field to fit. It fails without the fix (15 px against 12 px).
