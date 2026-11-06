### Clearing a Mail search lands in All mail

- **What happened:** A person started a search from a Focus view or a folder and then cleared it. Mail showed All mail instead of the view the search started from ([#1156](https://github.com/k2b-dev/cloud/issues/1156)).
- **Root cause:** Starting a search dropped the previous view from the URL state. Restoring its scroll alone also lost the position beyond page one, because changing the query source reloads only the first page.
- **Error class:** State lost on navigation or reload.
- **Guard:** `mail-navigation.test.ts` and `MailWorkspace.search-return.behavior.test.tsx` cover the starting view across clearing, reload, and Back. The behavior tests also require previously loaded pages to reload before the final scroll restore, and check that leaving during that load preserves the other view and its scroll.
