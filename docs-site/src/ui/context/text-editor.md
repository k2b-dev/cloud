# TextEditor

`TextEditor` edits Markdown in a formatted view with directly editable table
cells. Switch to Markdown to see and edit the same source. Use it when a text
field needs tables or a CodeMirror collaboration extension.

Import this optional entry point only in the editor island. It keeps CodeMirror
out of pages that use other UI components.

```tsx
import { TextEditor } from "@k2b/ui/text-editor";

<TextEditor
  label="Message"
  initialValue="Hello"
  maxLength={2_097_152}
  onChange={(markdown) => saveDraft(markdown)}
/>;
```

The application owns saving. `onChange` reports edits; it does not mean the
server has saved them. Pass an honest `status` to show save or connection state.

## Edit text and tables

The toolbar formats text and inserts links, lists, quotes, rules and tables.
The view switch changes presentation without rewriting the document.
`mode="plain"` shows unformatted text.

Click a table cell to type. Tab and Shift+Tab move between cells; Tab from the
last cell and Enter append a row. Escape returns to the text after the table.
The cell menu inserts or deletes rows and columns and changes alignment.
Open it with Shift+F10 or the context-menu key while a cell has focus.
Arrow keys enter a table from the adjacent text line; Tab from prose leaves
the editor instead of entering every cell.
On phones the table toolbar button opens the cell menu as a sheet.

Paste tab-separated cells from a spreadsheet or an HTML table. The first row
of a new table becomes its header. `maxPasteCells` defaults to 2,000; oversized
pastes are rejected with a visible message. `maxLength` is required and counts
UTF-16 code units. The server must enforce its own limit on merged documents.
Pasted images call `onDroppedImages(count, files)`; the application handles
attaching the available clipboard files. Images referenced only by pasted
HTML contribute to the count but have no local file.

All cells remain visible when a body row is wider than its header. The editor
shows **Check table** and offers **Complete columns**, also in source mode. Use `onTableCheck` to prevent
an application action, such as sending, until the extra cells are represented
in the header. Code blocks, quotes and nested list tables stay in source form.

## Connect collaboration

Pass CodeMirror bindings through `extensions`. The component has no transport
or Yjs dependency. `initialValue` is read once when mounted; subsequent shared
changes must arrive through the binding, not by replacing a controlled string.

A collaborative host supplies these members in `host`:

- `undo`, `redo` and `boundary` use the binding's history. Structural changes
  call `boundary` before and after the action.
- `structure.available()` reports whether server actions are available.
- `structure.perform(action, target)` captures stable document anchors
  synchronously from the target's current offsets, then sends the action to
  the server. Targets include table, row and header-cell offsets. Never send
  bare numeric offsets to a collaborative server: they may target another
  cell after concurrent changes. The server must reject deleted anchors.

Cell focus does not set CodeMirror's `view.hasFocus`. A collaboration adapter
uses `host.onCellSelection(selection)` to publish the cell's mapped source
selection; `null` means cell editing ended. The adapter then restores its
normal prose focus behavior. Binding `view.state.selection` alone is not
enough for a provider that checks `view.hasFocus`.

Only typing and appending a row run locally with a collaborative host.
Other structure actions call `perform`. A rejected promise leaves a visible
message asking the person to inspect the table before retrying. The host
applies accepted edits through the collaboration binding. An absent
`structure` host means a standalone local editor.

`host.renderCell(element, raw, table, row, column)` lets the application show
its own cell preview, such as a formula result. It runs outside active editing and refreshes when the table changes;
typing always edits the cell's original Markdown.

## Mount an engine in an existing editor

`createTextEditor({ parent, doc, label, host, extensions, ... })` returns
`{ view, setMode, setReadOnly, destroy }`. Call `destroy` on unmount.
Applications with an existing CodeMirror surface can compose `tableGrid()`
and `tableHost.of(host)` with their other extensions. These exports use the
same cell editing implementation as the component.

The optional `@k2b/ui/text-editor/model` entry point contains pure table
parsing and minimal text operations for a server action. It does not import
browser UI. Its changes use original source offsets; apply them in one
transaction and reparse before another operation.

## Loading and access

`loading` reserves the text area with a placeholder and blocks editing.
`readOnly` blocks editing and formatting. The mode switch remains available.
Neither replaces the application's server authorization.

If a cell disappears during composition or the length limit rejects input,
the editor preserves that input in a read-only field for copying. Closing a
notice does not discard it. Editing pauses until the person has copied and
dismissed the preserved input, so another rejected edit cannot overwrite it.

`onReady` receives the engine controller after mount. UI labels and inserted column names inherit the
UI locale. Direct engine consumers can supply `textEditorFormatLabels.of({
link, column })` through `extensions` for localized insertion text. Render an identical locale on the server and in the browser.
