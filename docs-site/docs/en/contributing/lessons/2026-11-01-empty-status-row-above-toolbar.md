### An empty status row pushed the Mail formatting toolbar down

- **What happened:** In the Mail composer, about 35 px of empty space sat between the pane tabs and the formatting toolbar.
- **Root cause:** `TextEditor` decided whether to render its status row with `"status" in props`. Solid defines that key for every `status={…}` attribute, even when the value is `undefined`, so Mail's unshared composer always got an empty 24 px row. Mail's editor wrapper added another 8 px of top padding.
- **Error class:** A slot reserved by the presence of a prop instead of by its content stays reserved when it is empty.
- **Guard:** `packages/mail/src/frontend/_components/MailComposerEditor.browser.test.ts` ("Mail composer layout" measures subject → pane tabs → toolbar and the preview alignment, and expects no `.k2b-ste-status` row without a status).
