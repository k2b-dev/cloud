### The access dialog's states and level menu drifted from the approved mockup

- **What happened:** The Code lane's checklist against the approved rights-editor mockup (v31) found the shared access dialog off in several states. An empty search said "No results found" instead of naming the search. Someone already on the list vanished from the results instead of showing their level. Read-only mode kept switches and Cancel/Save. There was no loading state. The level was a plain select without what each level means. The sentence that all signed-in people means people only was missing.
- **Root cause:** The dialog was built state by state from the concept, and only some mockup states had tests, so the rest were never compared with the published mockup.
- **Error class:** States of an approved mockup without a test drift silently while the tested ones stay right.
- **Guard:** `AccessDialog.behavior.test.tsx` covers each of these mockup states: empty search, taken result, read-only, loading and its failure, the level menu with descriptions and Remove, and the signed-in sentence. `AccessDialog.browser.test.ts` drives the level menu and checks that no row moves or overflows at 390 px.
