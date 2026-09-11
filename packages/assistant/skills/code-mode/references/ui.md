# UI and dialogs

Create controls once, then update their handles. Controls outside a layout
appear as root content. A control can belong to only one layout.

## Controls

```js
const input = ui.input("Name", {
  id: "name",
  placeholder: "Your name",
  onChange(value) { console.log(value); }
});
const status = ui.status("Ready");
const button = ui.button("Greet", () => {
  status.set(`Hello ${input.getValue()}`);
}, { id: "greet", icon: "ti ti-hand-wave", variant: "primary" });
ui.column({ gap: "md" }, [input, button, status]);
```

Buttons support `primary`, `secondary`, `ghost`, `text`, and `danger` variants.
Set `disabled` or `loading` where appropriate. Icons use Tabler CSS classes.

- `ui.text(text)`, `ui.status(text)` display text.
- `ui.input(label, options)` provides a text input.
- `ui.select(label, options, initialValue, id)` uses `{ value, label }` options.
- `ui.button(label, onClick, options)` invokes a callback.
- `ui.filePicker(label, { accept, multiple, onChange, ...options })` calls
  `onChange(files)` after a selection.
- `ui.row({ gap }, children)` and `ui.column({ gap }, children)` group handles.
- `ui.section({ title, description? }, children)` labels a group.
- `ui.workbench({ controls, content, footer? })` arranges controls beside content.
  Both `controls` and `content` must be arrays of handles. The optional footer
  accepts one `status` handle and an `actions` array and spans the full width.

```js
ui.workbench({ controls: [input, button], content: [status] });
```

Do not pass a column handle directly as `controls` or `content`: wrap it in an
array, or use the individual controls. UI functions create their output as a
side effect. Do not return a UI handle from the entry function; handles contain
callbacks and cannot be returned as worker output.

Use `ui.markdown(source)` for formatted content inside a UI. This does not
create Markdown app pages or navigation entries.

## Collections

```js
const tasks = ui.list({
  id: "tasks",
  empty: { title: "Nothing to do" },
  actions: [{
    id: "complete", label: "Complete", icon: "ti ti-check",
    onClick(item) { tasks.remove([item.id]); }
  }]
}, [{ id: "first", title: "Try the app" }]);
```

Declare list actions once. Their callback receives the current item, including
its optional `data` object. Updating the list must not create new buttons.

Lists use `set(items)`, `upsert(items)`, and `remove(ids)`. Calling `remove()`
clears the collection. Items have stable `id`, `title`, optional `description`,
`icon`, and scalar `data` properties.

Tables use `ui.table({ id, columns, rowKey, empty? })`. Columns have `key` and
`label`; rows contain scalar values. Supply a unique `rowKey` for incremental
updates. Use the same `set`, `upsert`, and `remove` operations on its handle.

## Dialogs

Every modal requires a nonempty title. Await the result and handle cancellation.

```js
const values = await ui.modal.dialog({
  title: "Add task",
  fields: {
    title: { type: "text", label: "Task", required: true, maxLength: 200 },
    priority: { type: "number", label: "Priority", min: 1, max: 3, default: 2 }
  }
});
if (values === null) return;
```

- `ui.modal.confirm({ title, message })` returns a boolean.
- `ui.modal.text({ title, label, value?, required?, minLength?, maxLength? })`
  returns text or `null`.
- `ui.modal.number({ title, label, value?, required?, min?, max? })` returns a
  number or `null`.
- `ui.modal.dialog({ title, fields })` returns a plain object or `null`.

Schema fields support `text`, `number`, `boolean`, and `select`. Select options
use `{ value, label }`. Custom JavaScript validators are not transported to the
host. Use the supported schema constraints and validate domain rules after the
result returns. Test runs expose pending dialogs so an agent can answer them.

## Handle updates

- `handle.set(value)` replaces the displayed value: a string for text, status,
  buttons, inputs, selects, and Markdown; rows for a table; items for a list;
  a complete configuration for a chart; a fraction from 0 to 1 for progress.
- `input.getValue()` and `select.getValue()` read the current string value.
- `handle.setDisabled(boolean)` and `handle.setLoading(boolean)` control
  interaction. Await asynchronous actions and clear loading in `finally`.
- `handle.setDescription(text)` updates supporting text.
- `handle.setState("ready" | "empty" | "loading" | "error", description?)`
  changes the state. Table/list `set` derives ready/empty from their contents.
- `table.setColumns([{ key, label }])` replaces the column definitions.

`ui.progress()` creates a progress bar; call `progress.set(completed / total)`.
`ui.link(label, { href, newTab?, icon? })` creates a link. `ui.linkButton` accepts
those options plus the button display options. The host validates destinations.

`set` does not invoke input callbacks. Lists and tables merge full items/rows by
key with `upsert`, retaining existing order and appending new keys. Omitted
properties are not patched from the old item. Duplicate keys are rejected;
`remove([])` changes nothing, and `remove()` clears all items/rows. These methods
do not destroy the control or remove a layout from the UI.

Status descriptions passed to `setState("error", message)` are displayed instead
of the label. Calling `setState("ready")` clears the status description.
When testing validation, check the visible description as well as the state.
