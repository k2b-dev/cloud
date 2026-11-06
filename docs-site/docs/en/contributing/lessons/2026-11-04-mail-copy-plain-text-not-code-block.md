### Text copied from a plain-text mail pasted as a code block

- **What happened:** People copied lines from a plain-text mail in the reader or in the composer history and pasted them into the composer. The text arrived as a fenced code block instead of ordinary paragraphs.
- **Root cause:** The reader shows plain text in `<pre class="whitespace-pre-wrap">` to keep its line breaks. The browser copies that element into the clipboard HTML, and the composer's clean paste correctly turns `<pre>` and `white-space: pre-wrap` into a code block.
- **Error class:** Markup chosen only for layout leaks into the clipboard and carries a meaning that the receiving editor reads literally.
- **Guard:** The browser test "copies plain text as lines and paragraphs instead of preformatted HTML" in `MailMessageBody.browser.test.ts` copies with the real shortcut, also from the header into the body, and requires the shown text with its line breaks plus simple `<p>`/`<br>` clipboard HTML without `<pre>`. `plainTextClipboardHtml` has a unit test in `mail-message-presentation.test.ts`.
