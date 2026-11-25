### The v2 outline counted a dialog's primary action against the page's

- **What happened:** The v2 agent page (#4110) opens a dialog to create a key. `describeV2` reported "2 primary buttons" for the head's "Schlüssel erstellen" and the dialog's "Erstellen", and the page's test had to name that finding as an exception.
- **Root cause:** The rule "one primary action per page" counted every primary button below the root, and an open dialog or sheet stands below the same root as the page under it.
- **Error class:** A rule written for one surface counts across surfaces that a person sees one at a time.
- **Guard:** `packages/ui/src/v2/describe.test.ts` ("counts the primary action per surface") keeps one primary each for the page and an open dialog clean, and still reports two in one dialog or two on the page.
