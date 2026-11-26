### A v2 sign-in field could not tell a password manager what to fill in

- **What happened:** Moving the sign-in pages to `@k2b/ui/v2` (#4173) needed `autocomplete="username"`, `current-password` and `one-time-code`, but `Input` passed none of the standard text-field attributes. The page set them through `ref` after hydration, so the server's markup, which a password manager reads first, had none.
- **Root cause:** `Input` listed only the props of its first screens and wrote nothing else into the element; there was no way to put a browser hint into the server's markup.
- **Error class:** A primitive that wraps a native control drops the control's standard attributes, so a page patches the element in the browser and the server's first markup differs from the live page.
- **Guard:** `Input` takes `autocomplete`, `maxLength`, `inputMode`, `spellcheck` and `autocapitalize` and writes them as attributes; `packages/ui/src/v2/server-markup.test.ts` checks them in the server's markup and `packages/ui/src/v2/hydration.browser.test.ts` checks that the live page keeps them.
