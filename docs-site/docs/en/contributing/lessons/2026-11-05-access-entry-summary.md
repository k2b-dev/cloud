### Access settings listed every grant twice instead of summing them up

- **What happened:** The approved rights-editor mockup opens the access dialog from one summary line. Every app's settings instead showed a second, read-only copy of the dialog's list. They had no "· 1 service account" count, and the English dialog said "identifier" where the glossary needs "handle".
- **Root cause:** Apps had only the read-only `PermissionEditor` to show who has access, so each one copied the list. The glossary still described every account without a person as a service account.
- **Error class:** A shared mockup state with no shared component, so every consumer approximated it on its own.
- **Guard:** `packages/cloud/src/access/AccessSummary.behavior.test.tsx` pins the summary line, its parts and plurals, one count per principal at its strongest grant, General in the app's words, and denied grants left out. The notebooks settings test asserts the summary in a real app. The glossary rows follow Bauplan 14.
