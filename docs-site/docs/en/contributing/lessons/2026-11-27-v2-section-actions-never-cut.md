### The buttons of a v2 section head were cut

- **What happened:** In Files at 800 px, the "Verwalten" button in a section head was cut. The detail beside the list had no room for the title and both buttons.
- **Root cause:** The title of `.k2-sh` did not wrap and kept its whole width, so the buttons at the end shrank.
- **Error class:** A head whose controls give way by shrinking, so a label is cut, while the text beside them keeps its width.
- **Guard:** `packages/ui/src/v2/section-actions.browser.test.ts`, at 800 and 1440 px in Chromium and WebKit. In every head no button is cut, and the title stands before the buttons and shortens first. Folding the buttons into "⋯" will come with the shared fold of a bar's end (#4392), and this test guards it then.
