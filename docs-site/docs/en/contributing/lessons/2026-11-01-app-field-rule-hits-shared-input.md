### The focused name field in the notes site showed blue only at its corners

- **What happened:** In the settings dialog of the public notes site, a focused name field showed a grey line along its edges and blue fragments at the rounded corners.
- **Root cause:** `.n-field input[type="text"]` in `pwas/notes/src/styles.css` styled raw form inputs, and `class="n-field"` on `TextInput` made it match the inner `.k2b-input` too. The inner input gained a border, a radius and its own outline inside the shell that draws the focus ring, so two shapes overlapped.
- **Error class:** An application's element selector reaches inside a shared control and competes with the part that owns the control's look.
- **Guard:** The notes site now uses `TextInput` for every form field and has no such selector. `pwas/notes/src/app.browser.test.ts` focuses each field in the settings and report dialogs and requires no border, outline or radius on the inner input and one ring on the shell.
