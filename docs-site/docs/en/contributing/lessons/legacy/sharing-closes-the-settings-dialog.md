### Sharing closes the settings dialog

- **What happened:** Adding a person in Space settings reloaded the page and discarded the open dialog ([#1176](https://github.com/k2b-dev/cloud/issues/1176)).
- **Root cause:** The grant's live event called `reloadOnce`, which reloaded immediately. Pending grants also disabled the picker input, so its focus restoration failed.
- **Error class:** State lost on navigation or reload; ordering and concurrency.
- **Guard:** `reload.behavior.test.ts` checks that an automatic reload never happens under a modal dialog and that, after the dialog closes, the page offers the reload instead of cancelling work confirmed in the dialog. `PermissionEditor.behavior.test.tsx` checks pending rows, focus in the read-only picker, blocked picks while saving, disabled row controls, duplicate picks, failure recovery, silent cancellation, and errors of grants that fail after the dialog closed. `space-settings.browser.test.ts` covers the live event, the kept dialog and focus, and the offered reload on desktop and phone.
