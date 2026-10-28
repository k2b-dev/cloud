### A sheet trigger lost hover after the animation snapshot

- **What happened:** The RichSelect phone accessibility cases in WebKit started five trigger transitions while `settled()` was already waiting.
- **Root cause:** Opening the modal sheet moved focus to the dialog, but WebKit still matched `:hover` on the covered trigger. Retiring that hover state later started background and border-color transitions after the helper's initial animation snapshot. A local event trace reproduced the failure and showed the delayed hover removal.
- **Error class:** State sampled before it settled.
- **Guard:** Before its first phone accessibility audit, `rich-select.browser.test.ts` waits for the sheet's final focus and for the covered trigger to stop matching `:hover`. Only then does the unchanged `settled()` helper wait for the return transitions. The light/dark phone cases retain all accessibility rules and state checks.
