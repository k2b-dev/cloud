### A confirmed table replacement lost the source caret

- **What happened:** Applying a per-table Markdown draft closed the source editor without restoring focus to its confirmed cell.
- **Root cause:** Rebuilding the grid detached the active source editor, and the old cell's selection restoration could then steal its focus.
- **Error class:** Treating a nested editor's focus as the surrounding widget's selection during an asynchronous redraw.
- **Guard:** `text-editor-table-source.behavior.test.ts` opens the source from a focused cell, applies a structural receipt, and checks that the draft stays focused until the current target resolver returns focus to the resulting cell.
