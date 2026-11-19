### Mail recipients inherited badge decoration and a filled remove hover

- **What happened:** Recipient addresses appeared in bordered pills, the remove action gained a blue hover surface, and the following input hint was larger than the addresses.
- **Root cause:** Mail's recipient field combined the shared chip class with a default ghost IconButton and a larger input font. Native focus in WebKit exposed only the caret at the edge of the overflowing row; the field now scrolls the whole input into view.
- **Error class:** Domain input decoration obscures the intended text hierarchy and action states.
- **Guard:** `MailRecipientInput.styles.test.ts` checks the plain text contract; `MailRecipientInput.browser.test.ts` verifies transparent hover and keyboard focus, danger ink, stable geometry, removal with retained focus, reachable input, retained invalid input, and quiet disabled actions in both themes at desktop and phone widths.
