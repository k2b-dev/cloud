### A reactive availability update disabled the editor binding

- **What happened:** Appending a table row succeeded, but later characters reached CodeMirror without reaching the shared Y.Text.
- **Root cause:** The component's mode effect subscribed to host availability read during its imperative grid redraw. A history notification then re-entered CodeMirror during a binding update, and CodeMirror disabled the crashed plugin.
- **Error class:** Tracking incidental reads inside an imperative editor dispatch as reactive configuration dependencies.
- **Guard:** `text-editor-host.behavior.test.tsx` changes reactive history availability inside a binding update and checks continued writes and the exception sink. Notebook browser tests also collect console errors, where CodeMirror reports disabled plugins.
