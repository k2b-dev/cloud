# UI and dialogs

The built-in UI takes one options object per constructor. Create controls once,
then update typed handles. A control belongs to at most one layout; unowned
controls appear as roots. See [Analytics UI](analytics.md) for all controls,
formats, charts, tables, shared filters, and structured interaction events.

```js
const input = ui.input({label:"Name", id:"name", value:"", placeholder:"Your name"});
const status = ui.text({value:"Ready"});
const button = ui.button({label:"Greet", id:"greet", variant:"primary", onClick() {
  status.setValue(`Hello ${input.getValue()}`);
}});
ui.column({children:[input, button, status]});
```

Use `ui.text({value:source, markdown:true})` for formatted content, including
links. Use `ui.table({rows, rowKey, columns})` for scalar records with unique
string keys; `table.setData(rows)` replaces its data while retaining valid
selection. Keep domain data in your own array and derive updates explicitly.
Use `ui.grid`, `ui.row`, `ui.column`, and `ui.section` to compose views.
Background job progress is available through `work` and the host's work status.

Text and input handles expose `setValue`; data views expose `setData`.
Setters never invoke user callbacks. Only use methods documented for that handle.
UI creation has side effects: do not return UI handles as worker output.

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

All modal methods additionally accept `confirmText?`, `cancelText?`, and
`variant?: "primary" | "success" | "danger"`. Text modals also accept
`multiline?: boolean`. Titles, labels and button captions must be nonempty.

Dialog `fields` is an object keyed by identifiers matching
`[a-zA-Z][a-zA-Z0-9_]*` (1–64 fields). Every field requires `type` and `label`;
common optional fields are `description`, `placeholder`, and `required`.

| Field type | Additional optional fields |
| --- | --- |
| `text` | `default: string`, `multiline: boolean`, `minLength`, `maxLength` |
| `number` | `default: number`, `min`, `max`, `step` (positive) |
| `boolean` | `default: boolean` |
| `select` | Required `options: [{value,label,icon?,description?}]`; optional `default: string` |

Select option values are unique, nonempty strings; a default must match one.
Dialog results contain every field key: text is a string, number a number,
boolean a boolean, and select the option's string value. Empty optional text
returns `""`; other empty optional fields return `null`. Cancelling the dialog
returns `null`. `default` initializes a field; it is not a replacement for an
omitted answer in an agent interaction.

Custom JavaScript validators are not transported to the host. Validate domain
rules after the result returns. Test runs expose pending dialogs so an agent
can answer them.
