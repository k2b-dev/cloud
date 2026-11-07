### A nested editor is declared as an island entry

- **What happened:** A lazily imported editor uses the `.client.tsx` suffix even though another island owns its mount, so the browser module graph violates the SSR entry contract.
- **Root cause:** A nested lazy module used the .client.tsx suffix, declaring a second browser entry inside an existing island.
- **Error class:** A nested editor is declared as an island entry
- **Guard:** Guard: SSR's nested component import check stays enabled; nested editors use ordinary `.tsx` modules. Mail's `MailComposerEditor.render.test.tsx` checks the loading shell, and `MailComposerEditor.browser.test.ts` checks that the lazy plain editor mounts with its accessible name and reports edits.
