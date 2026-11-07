### Read completed financial confirmations from the issued document

- **What happened:** Repeating a successful Grids financial document confirmation failed instead of returning the issued document.
- **Root cause:** Completion clears the receipt's frozen request, but the capability's completion and review paths still tried to parse it.
- **Error class:** A replay reads temporary reservation data after a lifecycle transition removes it.
- **Guard:** `integrity-capabilities.integration.test.ts` repeats both review and confirmation for issued DATEV and SEPA documents and checks that confirmation returns the same document.
