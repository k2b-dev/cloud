### Read CodeMirror source bytes and rendered lines separately

- **What happened:** The Mail source/plain browser guard reported extra blank lines after a table edit although the editor document and emitted body retained their original bytes.
- **Root cause:** Reading the whole CodeMirror content element through `innerText` includes browser-generated separators around empty block lines. Those separators are not source characters.
- **Error class:** Layout-derived DOM text mistaken for document bytes.
- **Guard:** `MailComposerEditor.browser.test.ts` compares both the exact CodeMirror document and emitted body with the expected source, and separately compares every rendered `.cm-line` with the corresponding source line on desktop and phone.
