### A table row clipped the instruction it was meant to show

- **What happened:** A Mail incoming automation that needed its Spaces targets confirmed showed its badge and instruction inside the table's name cell. At desktop and phone widths the cell clipped both to "Prüfun…" and "Bitte Spaces-Zugriff bestätigen: Automa…". The editor's footer hint also ran under its buttons on a phone.
- **Root cause:** The instruction and its action lived in a fixed-width table cell, and the footer hint used `flex-1`, whose zero basis kept it on the buttons' line instead of letting the footer wrap.
- **Error class:** State text placed where the layout truncates or squeezes it, verified only by DOM text tests that cannot see clipping.
- **Guard:** `MailIncomingAutomationSettings.browser.test.ts` renders the state in Chromium at 1440 px and 390 px, asserts the badge fits its cell and the footer hint never overlaps the buttons. What to do stands in one notice above the list.
