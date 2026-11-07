### The phone list lost its head with the automatic layout

- **What happened:** On a phone with the layout "Automatisch" or "Spalten" and no open conversation, the Mail list showed no head: no tabs and no Compose (#2507).
- **Root cause:** Mail bound its `AppWorkspace.Head` to the `conversations` pane. Without an open conversation those layouts put the list into Main instead, so the active phone region was `main` and `@k2b/ui` hid the head as designed.
- **Error class:** A head's `mobilePane` names a fixed pane while the content it belongs to moves between Main and a pane with the layout.
- **Guard:** The Mail shell browser test "390 <layout>: the list shows its head with tabs and Compose" checks every layout at 390 px, with and without an open conversation, in the server frame and after Back.
