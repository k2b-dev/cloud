### The buttons of a v2 section head were cut

- **What happened:** In Files at 800 px, the "Verwalten" button in a section head was cut. The detail beside the list had no room for the title and both buttons.
- **Root cause:** The title of `.k2-sh` did not wrap and kept its whole width, so the buttons at the end shrank. Nothing folded them when the head was too narrow.
- **Error class:** A head whose controls give way by shrinking instead of whole, so a label is cut.
- **Guard:** `packages/ui/src/v2/section-actions.browser.test.ts`, at 800 and 1440 px in Chromium and WebKit. In every head no button is cut and the title stands before the buttons. A head without room folds its buttons into "⋯", whose menu holds them and runs them; with room again they come back with their words.
