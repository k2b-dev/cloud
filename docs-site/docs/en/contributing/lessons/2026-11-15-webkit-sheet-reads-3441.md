### Boxes read while a sheet slides in look like overlapping choices in WebKit

- **What happened:** The draft collaboration dialog's phone test failed in WebKit merge-queue runs: its two choices seemed neither side by side nor stacked.
- **Root cause:** The test read the button boxes right after `locator.waitFor()`, while the bottom sheet still slid in, and WebKit moves a running animation on between two reads in one `evaluate()`, so the second button sat a few pixels higher than the first.
- **Error class:** Comparing geometry read during an entrance animation, which only Chromium keeps fixed within one task.
- **Guard:** The phone cases of `MailDraftCollaborationDialog.browser.test.ts` await `settled(page)` before they read boxes; the testing guide's engine differences name the WebKit behaviour.
