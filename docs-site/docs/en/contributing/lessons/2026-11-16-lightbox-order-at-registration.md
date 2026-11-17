### The Lightbox of an answer stepped in the order its blocks loaded, not the order they stand

- **What happened:** In WebKit, → in the Lightbox of a chat answer did nothing. Its strip read "PayPal-Umsatz, Kennzahlen, PayPal-Buchungen", so the open table was the last item. The test waiting for the next name timed out (#3527).
- **Root cause:** `AnswerBlocks` sorted its blocks by their place in the page in a memo that ran when each block registered. A block registers while it is built, before its anchor is in the page, so every comparison returned 0 and the order stayed the order the blocks loaded. That order depends on when lazy code arrives and differs between engines.
- **Error class:** An order read from the DOM before the elements were in it.
- **Guard:** The order is read when the Lightbox opens. The scene `baustein&late` lets the first block arrive last; `approval-scenes.browser.test.ts` checks the strip and steps from the table to the figures, and it is red in Chromium without the fix. The longer Lightbox test is split in two, so each stays well inside five seconds in WebKit.
