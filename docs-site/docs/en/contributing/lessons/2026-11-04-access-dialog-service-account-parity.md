### Server presentation fields reach the dialog only when a test reads them

- **What happened:** The access dialog showed every service account as "Service account" and never linked its name, although the server already returned `serviceAccountDescription` and `serviceAccountHref`; the identifier field needed an extra Find step, a new Code row started with View, and on a phone the add button fell below the section title.
- **Root cause:** The draft rows copied only name, picture and kind from an entry, and the dialog's tests checked texts that existed instead of the approved mockup's states at both widths.
- **Error class:** A shared component drops presentation fields of a contract it renders, and mockup states without a test drift silently.
- **Guard:** `packages/cloud/src/access/AccessDialog.behavior.test.tsx` reads the server's line, link, level, count and confirmation per row; `AccessDialog.browser.test.ts` checks the states leer, normal, dienst-hinzu, dienst-neu and lesen at 1280 and 390 px (button beside the title, field and hit in view, no cut-off level).
