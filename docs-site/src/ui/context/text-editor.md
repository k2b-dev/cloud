# TextEditor

`TextEditor` edits Markdown in a formatted view with directly editable table
cells. Switch to Markdown to see and edit the same source. Use it when a text
field needs tables or a CodeMirror collaboration extension.

## Use TextEditor

Use the formatted view for editing prose and tables together. Choose
`mode="plain"` for text without Markdown formatting, or `mode="source"` when
the person needs the complete Markdown source. The application owns saving.
`onChange` reports edits; it does not mean the server has saved them. Pass an
honest `status` to show save or connection state.

## Import

Import this optional entry point in the editor's browser module. It keeps
CodeMirror out of pages that use other UI components. Load that module when
the editor is needed.

```tsx
import { TextEditor } from "@k2b/ui/text-editor";
```

## Example

```tsx
import { TextEditor } from "@k2b/ui/text-editor";

<TextEditor
  label="Message"
  initialValue="Hello"
  maxLength={2_097_152}
  onChange={(markdown) => saveDraft(markdown)}
/>;
```

## Edit text and tables

The toolbar formats text and inserts links, lists, quotes, rules and tables.
The view switch changes presentation without rewriting the document.
`mode="plain"` shows unformatted text.

Click a table cell to type. Tab and Shift+Tab move between cells; Tab from the
last cell appends a row. Enter moves down, appends from a nonempty last row,
or leaves an empty last row. Escape returns to the text after the table.
The cell menu inserts, moves or deletes rows and columns, changes alignment,
toggles the header, copies the table or its Markdown, and deletes the table.
Alt+ArrowUp/ArrowDown moves the active row; Alt+ArrowLeft/ArrowRight moves its
column. An all-empty GFM header is hidden without removing its source cells.
Open the same menu from a row or column grip, by right-clicking a cell, or
with Shift+F10 or the context-menu key while a cell has focus.
Arrow keys enter a table from the adjacent text line; Tab from prose leaves
the editor instead of entering every cell.
The menu names the active row and column and keeps its target cell outlined.
It groups row, column, alignment and table actions. On phones the table toolbar button opens a sheet with two columns of
44-pixel touch targets; it occupies at most 62% of the viewport and scrolls
inside that space. The sheet stays open after moving a row or column. Read-only tables expose only copying;
formula previews keep their rendered values when selected.

**Edit as Markdown** opens only that table's source in its existing space.
**Show as table** returns to the cell at the source caret after confirmation.
Invalid or stale drafts remain editable and copyable. A collaborative host must
authorize structural source changes; ordinary cell edits use its text binding.
`host.tabMovesFocus()` lets a host preserve a personal Tab-for-focus preference.

Paste tab-separated cells from a spreadsheet or an HTML table. The first row
of a new table becomes its header. `maxPasteCells` defaults to 2,000; oversized
pastes are rejected with a visible message. `maxLength` is required and counts
UTF-16 code units. The server must enforce its own limit on merged documents.
Pasted images call `onDroppedImages(count, files)`; the application handles
attaching the available clipboard files. Images referenced only by pasted
HTML contribute to the count but have no local file. Return `true` when the
application attached the images itself, so the hint stays hidden. Otherwise
the editor shows **Add images as attachments**. Supply `onAttachImages` to make
that hint a button opening the application's attachment picker.

The HTML sanitizer loads on the first HTML paste. If the text, selection,
focus or editability changes while it loads, or loading fails, the editor
keeps the pasted text in its copyable recovery surface. Plain text paste does
not load the sanitizer.

Pasting code into a fenced,
indented or inline code region preserves the clipboard's plain text, including
indentation and blank lines. HTML-only code and whitespace-preserving editor
clipboards keep their literal spacing; outside code they become fenced blocks.

All cells remain visible when a body row is wider than its header. The editor
shows **Check table** and offers **Complete columns**, also in source mode. Use `onTableCheck` to prevent
an application action, such as sending, until the extra cells are represented
in the header. Two consecutive pipe-framed rows with a missing or damaged
separator also show **Check table**; **Check Markdown** opens the source without
changing its text. Literal pipe-framed paragraphs can be escaped or fenced.
Applications with a controlled mode must handle `onModeChange` so this recovery
choice updates their own view preference. Code blocks, quotes and nested list
tables stay in source form.

## Connect collaboration

Pass CodeMirror bindings through `extensions`. The component has no transport
or Yjs dependency. `initialValue` is read once when mounted; subsequent shared
changes must arrive through the binding, not by replacing a controlled string.

A collaborative host supplies these members in `host`:

- `undo`, `redo` and `boundary` use the binding's history. Structural changes
  call `boundary` before and after the action. Without `undo`, the component
  keeps its own CodeMirror history.
- `structure.available()` reports whether server actions are available.
- `structure.perform(action, target)` captures stable document anchors
  synchronously from the target's current offsets, then sends the action to
  the server. Targets include table, row and header-cell offsets. Never send
  bare numeric offsets to a collaborative server: they may target another
  cell after concurrent changes. The server must reject deleted anchors.
  After confirmation, return a `TableFocusTarget` callback to restore the
  caret. It resolves the result's fixed identities against the current binding
  and returns a current `TableTarget`, or `null` if the target no longer exists.
  The editor yields focus to a newer user gesture while the action is pending.
- Optional `structure.replaceSource(target, expected, source, caret)` applies a valid
  per-table Markdown draft through the same anchored server boundary. Capture
  anchors synchronously and compare the exact `expected` source at the server.
  Resolve only after its confirmed update reaches the binding; reject a refused
  or cancelled request. The editor keeps the draft while pending or rejected,
  and preserves it through `onRecovery` if its view is disposed. `caret` names
  the row and column in the draft; return the same focus callback to restore
  that cell after the confirmed replacement. Without this
  method, structural drafts remain local with a visible explanation.

Cell focus does not set CodeMirror's `view.hasFocus`. A collaboration adapter
uses `host.onCellSelection(selection)` to publish the cell's mapped source
selection; `null` means cell editing ended. The adapter then restores its
normal prose focus behavior. Binding `view.state.selection` alone is not
enough for a provider that checks `view.hasFocus`.

Only typing and appending a row run locally with a collaborative host.
Other structure actions call `perform`. A rejected promise leaves a visible
message asking the person to inspect the table before retrying. A host that
has the server's own reason resolves the promise and shows that reason with
`controls.notify(message)` instead. The host
applies accepted edits through the collaboration binding. An absent
`structure` host means a standalone local editor.

`host.renderCell(element, raw, table, row, column)` lets the application show
its own cell preview, such as a formula result. It runs outside active editing and refreshes when the table changes;
typing always edits the cell's original Markdown.

## Keep an application's own presentation and toolbar

An application presentation without a `status` prop adds no empty status row
above its content. Table warnings still appear when needed. Supplying `status`
reserves that row across status transitions; the standalone editor also keeps
its reserved row.

An application with its own Markdown presentation, such as Notebooks, passes
`presentation` and `toolbar={false}`. `presentation(mode)` replaces the
built-in Markdown language, highlighting, hidden markers and formatting keys
for `formatted` and `source`; return `[]` when the application installs them
through `extensions`. The editor surface then carries no shared text styling.
The table grid, cell menu, **Check table**, notices, paste rules and the
length limit stay shared, so tables look and behave as in every other editor.

With `toolbar={false}`, the application renders its own toolbar and mode
control and passes `mode`. `onReady(editor, controls)` provides the shared
table controls for that toolbar:

- `controls.tableActive()` reports a focused cell in the formatted view.
- `controls.TableMenu({ class, size, position })` renders the shared cell menu
  behind a trigger in the application's style. Place it where the toolbar
  otherwise inserts a table; on phones it opens as a sheet.
- `controls.formatCell(format)` applies bold, italic, strikethrough, inline
  code or a link to the focused cell. An app-specific paired delimiter can be
  passed as `{ marker: "==" }`; its rendering and keyboard binding remain app
  extensions. Empty delimiters, pipes and line breaks are rejected. Disable block formats while a cell has
  focus: they would split the row.
- `controls.notify(message)` shows an application message in the editor's
  notice.

Use `TableSizePicker({ maxRows, maxColumns, onPick, onReady?, disabled? })`
for the insertion control. It opens a pointer grid on desktop and large size
fields in a phone sheet. `onReady(open)` lets a slash command or another menu
open the same picker. Recheck write access when `onPick` runs: access may have
changed while the picker was open.

## Mount an engine in an existing editor

`createTextEditor({ parent, doc, label, host, extensions, presentation, ... })`
returns `{ view, setMode, setReadOnly, setLabel, destroy }`. Call `destroy` on unmount.
The engine routes undo and redo to `host.undo` and `host.redo` and installs no
history of its own; a standalone engine passes CodeMirror's `history()`
through `extensions` and calls its `undo` and `redo` commands. `setMode` also
re-reads `presentation`.
Applications with an existing CodeMirror surface can compose `tableGrid()`
and `tableHost.of(host)` with their other extensions. These exports use the
same cell editing implementation as the component.

The optional `@k2b/ui/text-editor/model` entry point contains pure table
parsing and minimal text operations for a server action. It does not import
browser UI. Its changes use original source offsets; apply them in one
transaction and reparse before another operation.

## Loading and access

`loading` reserves the text area with a placeholder and blocks editing.
`readOnly` blocks editing and hides the built-in toolbar, including its mode
switch. Neither replaces the application's server authorization.

The length limit refuses only edits that make an over-limit text longer, so a
text above the limit can still be shortened.

If a cell disappears during composition, an unmaterialized cell loses its
position after another edit, or the length limit rejects input,
the editor preserves that input in a read-only field for copying. Closing a
notice does not discard it. Editing pauses until the person has copied and
dismissed the preserved input, so another rejected edit cannot overwrite it.

`onReady` receives the engine controller after mount. UI labels and inserted column names inherit the
UI locale. Direct engine consumers can supply `textEditorFormatLabels.of({
link, column })` through `extensions` for localized insertion text. Render an identical locale on the server and in the browser.

`repairTables(text, maxLength)` provides insertion-only padding for recognized ragged GFM tables. It counts the required padding before allocating it and returns no changes if it cannot fit the text budget; the damage stays visible. Run it through the owning application's ordered document writer. It leaves valid tables, fenced code, quotes and unrecognized damage unchanged; it does not authorize an action or resolve every form of Markdown damage.

`inspectTableStructure(text)` reports extra body cells and pipe-framed paragraphs
with a missing separator. Applications can use the same predicate before
formatted output; it never rewrites the source. Mail additionally refuses those
states at its shared preview/send renderer. The predicate alone does not replace
server authorization, convergence checks or send ordering.

## Accessibility

Supply a descriptive `label`; the editor uses it as the accessible name of
its text input. Formatting controls have labels, and the mode control exposes
its selected state. Table cells support the keyboard navigation described
above; the context-menu key or Shift+F10 opens the cell menu. Tab from prose
leaves the editor.

Loading and recovery messages use status regions. Rejected input remains in
a read-only field so the person can copy it before continuing. Keep the
editor's shared focus styles and provide the same actions when composing an
application-owned toolbar.

## Runtime

The server renders a loading surface and, for editable Markdown modes, the
toolbar. CodeMirror mounts in the browser, then `onReady` receives its
controller and shared controls.
`initialValue` seeds that mount once; later changes arrive through the
binding or controller. Unmounting the component destroys its editor. Direct
`createTextEditor` consumers must call `destroy` themselves.

The component inherits the UI locale and light or dark theme. A browser
module can load lazily without loading the editor on other pages. HTML paste
loads its sanitizer on demand, as described above.
