### The large composer's preview stood still for a plain-text message

- **What happened:** Written large, a plain-text reply showed its preview as a tab behind the draft, and once opened the preview kept the text from when it opened, although its line said it follows the typing.
- **Root cause:** Two copies of the preview gate disagreed. The preview query accepted plain text in the large composer (`format() === "markdown" || largePreview()`), but the effect that sends each typed change still stopped for anything but Markdown. The composer in a window also started from the page's trimmed arrangement, which drops the preview for plain text, so the large layout added it back as a tab.
- **Error class:** One condition written out twice by hand for a query and the effect that feeds it; widening one copy leaves the other behind.
- **Guard:** `previewWanted()` in `MailComposer.tsx` is the single gate for both, and `MailComposer.window.behavior.test.tsx` ("written large, the preview of a plain-text message follows the typing") opens a plain-text draft large, checks the preview stands beside the draft, types, and waits for the preview request with the new text.
