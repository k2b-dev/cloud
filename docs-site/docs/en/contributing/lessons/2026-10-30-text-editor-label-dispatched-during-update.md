### Renaming the text editor during a view update threw

- **What happened:** The k2b notes SPA names its editor after the note's title. When typing changed the title, `TextEditor` passed the new `label` to `setLabel`, which dispatched a reconfiguration while CodeMirror was still updating the view. CodeMirror threw "Calls to EditorView.update are not allowed while an update is in progress"; the SPA worked around it with a memo.
- **Root cause:** `setLabel` in `packages/ui/src/text-editor/engine.ts` changed `aria-label` through a compartment, so every label change needed its own `dispatch`. A Solid effect that a plugin's signal write runs synchronously calls it in the middle of an update.
- **Error class:** A host-facing setter that dispatches to CodeMirror is called from reactive state that can change during an editor update.
- **Guard:** The label is a mutable value read by a `contentAttributes` function and written to the content element directly; changing it never dispatches. `packages/ui/test/text-editor-label.behavior.test.ts` renames the editor from a view plugin's update and fails without the fix.
