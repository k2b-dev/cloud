### Mail hid inline quotes and forwarded messages as quoted history

- **What happened:** The mail reader collapsed every `>` quoted block and every HTML quote container behind **Show quoted text**. Inline answers, bottom-posted replies, and Gmail or Apple Mail forwards lost the text that people needed to read.
- **Root cause:** The plain-text splitter and the frame script treated each quote as history by its markup alone. Neither checked where the quote stands in the message or whether it introduces a forwarded original.
- **Error class:** A content classifier decides by local markup and ignores the position and context that give the markup its meaning.
- **Guard:** `mail-message-presentation.test.ts` and the browser test "collapses only the quoted conversation that ends a message" in `MailMessageBody.browser.test.ts` cover trailing replies, inline and bottom-posted quotes including Gmail's split quote container, an unanswered closing quote, a quote in the middle, a quote-only message with or without its attribution, signatures after history, and forwards.
