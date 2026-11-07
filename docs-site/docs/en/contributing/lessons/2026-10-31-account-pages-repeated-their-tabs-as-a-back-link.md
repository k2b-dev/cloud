### Account pages repeated their own tabs and dialog close as a back link

- **What happened:** `/me/notifications/history` showed "‹ Notifications" above the account tabs, which already lead to the notification preferences, and `/me/security/pair` showed "‹ App sign-in" (or the user's name) above the pairing dialog, whose close already returns there. Valentin asked on 2026-10-31 to drop top back links that are not the only way back.
- **Root cause:** Both pages gave the shell a title array with their parent as a level, and these pages have no workspace sidebar that could hide the row, so it showed at every width.
- **Error class:** Shell chrome repeats navigation that the page's own tabs or dialog close already offer.
- **Guard:** `account-pages.browser.test.ts` checks that the delivery history's title array leaves no way up and that the page still links back to the notification preferences; the pairing dialog's close to its return address stays covered in `app-approval.behavior.test.tsx`.
