---
title: Kit browser apps
navTitle: Kit
section: Platform services
order: 1200
description: Author and share browser tools with isolated JavaScript, local files and a shared per-app workspace.
tags: [kit, browser, cli, permissions]
updated: 2026-09-09
---

# Kit browser apps

Kit hosts small JavaScript tools. Cloud stores their source and sharing grants.
User scripts execute in a terminable worker inside an opaque-origin iframe,
with network access blocked by CSP. File contents and results remain in the
browser unless the user downloads them. Scripts receive no Cloud credentials.

## Project and permissions

An app has a six-character public ID, a revision, a name, an optional description,
a local-storage setting and a set of JavaScript and Markdown files. Internal database UUIDs
are not author-facing IDs. Updates require the revision that was read; a stale
update returns `409 REVISION_CONFLICT`.

| Permission  | Behavior                                |
| ----------- | --------------------------------------- |
| Read        | List app metadata                       |
| Write / Use | Read source and run the saved app       |
| Admin       | Edit, preview, delete and manage grants |

User, group and authenticated-user grants use Cloud's access model. Use access
includes source visibility: browser-delivered JavaScript cannot hide secrets.
The final administrator grant cannot be removed or downgraded.

`/app/kit/<id>` is the default use view. `/app/kit/<id>/edit` requires admin
access and contains the file editor, preview and console. Preview compiles the
current editor contents; use mode compiles the saved revision only after the user clicks Start.
Opening the app, switching tools and closing settings never starts a tool. Keep `run()` for UI setup and attach processing to
callbacks. Restart and Stop sit beside the page title. A stopped tool shows a
centered green play icon without a background and a localized Start label. While starting, it becomes a spinner that remains
visible for at least 150 ms; explicit cancellation ends loading immediately. The sidebar footer contains Edit
and Settings, including metadata, sharing and a scoped local file explorer. Save code
changes before opening settings.

## Define tool pages

Every `*.script.js` file must export a literal `kit.script` definition:

```js
import { greeting } from "./greeting.js";
export default kit.script({
  name: "Welcome",
  icon: "ti ti-home",
  order: 10,
  run() {
    const name = kit.ui.input("Name", { value: "World" });
    const result = kit.ui.text("");
    const submit = kit.ui.button(
      "Greet",
      () => {
        result.set(greeting(name.getValue()));
      },
      { id: "greet" },
    );
    kit.ui.column({ gap: "md" }, [name, submit, result]);
  },
});
```

`greeting.js` can export `const greeting = name => "Hello " + name;`.
Helpers use `.js` filenames. Imports must be relative, include `.js`, and remain
inside the project. Dynamic imports and external dependencies are unsupported.
Navigation is discovered from source without executing it and sorted by order,
then path. The sidebar remains available for settings even with one tool.

## SDK namespaces

`cld kit sdk --json` returns the supported methods and signatures. The editor
uses the shared plain-text editor with standard code highlighting and no
autocompletion. File tabs occupy the left pane group; preview and console remain visible in a
separate group on the right, with one preview tab per tool and a resizable divider.
Switching preview tabs stops the current run and requires an explicit Start. The editor workspace
uses compact padding on every side. Add files
from the sidebar or tab-bar plus button; rename and delete through each file
item's menu. Cancel confirms discarding unsaved edits before returning to Use
mode. Ctrl/Cmd+S saves the project. The preview includes a permanently expanded
console in its own paper surface. Restart and Stop sit in the console header.
Each run begins with a localized start message; log lines include local timestamps
and three-letter level labels. Errors are red and warnings amber.
File and confirmation prompts have localized action titles and validate paths
before closing. New entry scripts open their preview tab without launching it.
Incomplete JavaScript keeps the existing tabs visible and shows a diagnostic
with the filename. Renaming a file updates static imports and re-exports,
including relative imports inside a moved file. Fix syntax errors before a rename
so Kit can update these references safely. The last entry script cannot be deleted.

Saving acknowledges the submitted version without replacing edits made while the
request was pending. A revision conflict preserves the draft and offers a JSON
download before explicitly loading the latest saved version. The draft contains
the project fields and expected revision. File tabs preserve undo, redo, cursor,
and scroll state for the current editor session. Undo and redo each keep at most
2 MiB of text snapshots per open file; oldest snapshots are discarded first.
Renaming or deleting a file ends that file's editor session.

Changing code does not restart a running preview. A notice identifies the older
preview until the next explicit launch. On narrow screens, Code and Preview
switch between full-width views while retaining their state.

Kit localizes its own controls, validation and API errors using the Cloud locale.
Script-authored labels, page names, Markdown and console diagnostics remain
unchanged. V1 does not offer an i18n API to script authors.

- `kit.ui`: workbenches, sections, file pickers, tables, lists, status, Markdown,
  links, buttons, input, selection, progress, rows and columns.
  Handles update existing output; events call worker callbacks.
- `kit.file`: open one file, multiple files or a directory tree, and offer downloads.
  Folder files preserve `webkitRelativePath`.
- `kit.sheet`: parse CSV with headers, preserving values as strings; export with
  semicolons, a UTF-8 BOM, CRLF and formula escaping by default.
- `kit.money`: the complete stdlib money namespace, executed directly in the worker.
- `kit.store`: get, set, delete and list JSON values.
- `kit.opfs`: read, write, delete and list relative file paths.

Select options always require separate `value` and visible `label` strings.
Optional `icon` (Cloud icon classes) and `description` appear in the shared select.
The handle returns the selected value, including whitespace such as a tab:

```js
const separator = kit.ui.select(
  "Delimiter",
  [
    { value: ";", label: "Semicolon (;)" },
    {
      value: "\t",
      label: "Tab",
      icon: "ti ti-arrow-right",
      description: "Tab-separated columns",
    },
  ],
  ";",
);
const file = await kit.file.open({ accept: ".csv,text/csv" });
```

`open` and `openMultiple` accept the optional HTML `accept` file-type filter.
It guides the chooser; scripts must still validate file contents.

`console.log`, `info`, `warn` and `error` appear in the editor console. Unhandled
script errors appear in the run view. Stop terminates the worker; already
accepted storage writes finish atomically, while queued work is discarded.

All tool pages share `kit/<appShortId>/<userId>/files/` and `kv/` in OPFS.
Scripts see relative paths and keys. The project manifest controls script storage access through `persistenceEnabled`.
It is local to that origin, browser profile and user, with no cross-device sync.
Missing files and keys return `null`. Clearing browser data removes the results.

The interactive runtime accepts 2 MiB of source across at most 64 files, with
1 MiB per file, 300 UI nodes, 1,000 rows per visible table, and 16 MiB per local
item and download. `kit.file.save()` immediately requests a browser download;
Kit does not add another confirmation button. Browser download settings still apply.
Lists return at most 1,000 entries. Display large datasets
in smaller selections; browser quota errors are reported to the script.

## Workbench UI

Build a page from handles. A handle belongs to one parent; a workbench is a single
root layout. Its input rail and result area stack on narrow screens. Groups,
controls, tables, lists and feedback use the shared Cloud UI components.

```js
const status = kit.ui.status("Choose a file");
const table = kit.ui.table({
  columns: [],
  label: "Preview",
  empty: {
    title: "No file selected",
    description: "Choose a CSV to preview it.",
  },
});
const picker = kit.ui.filePicker("Choose CSV", {
  accept: ".csv,text/csv",
  async onChange(files) {
    const rows = await kit.sheet.fromCsv(files[0]);
    table.setColumns(
      Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key })),
    );
    table.set(rows.slice(0, 100));
    status.set(`${rows.length} rows`);
  },
});
kit.ui.workbench({
  controls: [kit.ui.section({ title: "Input" }, [picker])],
  content: [kit.ui.section({ title: "Preview" }, [table])],
  footer: { status },
});
```

`filePicker` supports `multiple`, `description`, `icon`, `id` and an
`onChange(files)` callback. Cancellation preserves the previous selection.
Files cross the host bridge; they never become JSON UI nodes.

Tables support dynamic `setColumns([{ key, label, align? }])`, `set(rows)`
and `setState("ready" | "empty" | "loading" | "error", description?)`.
`set` selects ready or empty automatically. Button handles support
`setDisabled(boolean)` and `setLoading(boolean)`; buttons default to secondary.
Use `variant: "primary"` for the main action. Inputs accept `description`,
`placeholder` and `onChange(value)` in addition to their initial value.

Use lists for export history and similar collections:

```js
kit.ui.list({ title: "Exports", empty: { title: "No exports yet" } }, [
  {
    id: "result.csv",
    title: "result.csv",
    description: "120 rows",
    icon: "ti ti-file-type-csv",
    action: kit.ui.button("Download", async () => {
      const file = await kit.opfs.read("result.csv");
      if (file) await kit.file.save(file, "result.csv");
    }),
  },
]);
```

List item IDs must be unique. Each optional `action` is an existing UI handle.

`ui.list` handles expose `set(items)` to replace the visible rows. Use stable,
unique item IDs and reuse action handles across refreshes. A row action can be
a `ui.row` containing several buttons. Actions stay owned by their list while
their item is absent; they do not appear as standalone controls. The existing
limits on allocated UI nodes and visible rows still apply.

The CSV starter retains its existing history keys and files and shows the latest
50 exports with download actions. A table preview shows 100 rows; export uses all
parsed rows and preserves identifiers as strings. If local history cannot be
stored (for example, storage is disabled), the CSV download remains available
and the status explains that it was not added to history.

`ui.link(label, { href, newTab?, icon? })` renders a text link.
`ui.linkButton` adds button options such as `variant` and `disabled`.
Both allow relative URLs, HTTP(S) and mailto. Navigation requires a user action;
these controls do not grant network access to worker scripts.

`ui.markdown(source, { headingScale? })` uses the shared Markdown renderer.
Update it with `set(source)`. Raw HTML is escaped, image syntax displays
alt text without loading resources, and links use the same protocol policy and
open in a new tab. Heading scales are compact, normal (default) and large.

## CLI authoring

```sh
cld kit init ./csv-tool
cld kit validate ./csv-tool
cld kit push ./csv-tool --json
cld kit list --json
cld kit pull abc123 ./csv-tool-copy
cld kit access grant abc123 --help
```

`kit.json` lists source paths, metadata and, after push or pull, the app ID and
revision. Edit the local files and push again to save that revision. Add new
source paths to the manifest. Pull requires a new output directory. The same
permission-aware service handles GUI and CLI operations.

PDF parsing, AI calls, QR codes, custom HTML and server-side Markdown-to-PDF
are outside this installation slice.

The workbench `footer` spans both columns: status stays on the left and actions
on the right. It stacks naturally with the workbench on narrow screens.

Disabling local persistence blocks both reads and writes through `kit.store` and
`kit.opfs`; it does not delete existing data or provide temporary storage. Data
becomes accessible again after re-enabling persistence. Scripts must handle
storage errors. Saving application settings stops the current run.

The Local data sidebar item opens an explorer for files and saved KV values for this app and the
current user on this device, including nested file paths. Refresh reloads the
list; Download exports a file unchanged or a KV value as JSON. The explorer can
inspect retained data even when script storage access is disabled. General
settings do not expose a persistence toggle and preserve the manifest value.

All users with Use access can open this explorer above Settings in the sidebar.
They can delete individual files or KV values, or select Delete local data to
clear both. Confirmation stops the current run, waits for its pending storage
operations and deletes only the selected data for this app/current user. Other apps and users retain their data. Close other tabs running the
same app before deleting local data. The project and its sharing remain intact.

### Exact money

`kit.money` exposes stdlib's `fromMinor`, `fromDecimal`, `toDecimal`,
`currencyDigits`, `parse`, `format`, `add`, `subtract`, `sum`, `compare`,
`multiply`, `divide`, `taxFromNet`, `taxFromGross` and `allocate` unchanged.
Values are JSON objects `{ amount, currency }`. Amounts are signed safe integers
in currency minor units (cents for EUR); arithmetic rejects mixed currencies.

```js
const net = kit.money.parse("1.234,56", { locale: "de-DE", currency: "EUR" });
const { gross } = kit.money.taxFromNet(net, { percent: "19", rounding: "half-up" });
kit.ui.text(kit.money.format(gross, { locale: "de-DE" }));
const csvAmount = kit.money.toDecimal(gross).replace(".", ",");
const shares = kit.money.allocate(gross, [1, 1, 1]);
```

Parsing and formatting require an explicit locale. Numeric input does not accept
currency symbols. Multiplication, division and taxes require `rounding`:
`half-up`, `half-even` or `toward-zero`. Decimal parsing requires a rounding rule
when input exceeds currency precision. Tax percentages and decimal factors are
strings. Allocation preserves the exact total, including for credits. Invalid
input throws; scripts handle these errors like other JavaScript errors.


## Assistant authoring and Help

The built-in `cloud-kit` Assistant Skill uses `search_help` and `read_help` to
read Kit's registered Help before selecting SDK methods. Help includes guides
for using, editing, programming with Assistant, and sharing apps, plus SDK
articles grouped by namespace, with separate UI handles, field types, modals and
charts. Start with `kit-sdk-runtime`, then read the method and its linked option
tables. Signatures, argument definitions, examples, schema projections and
localized descriptions come from the same `sdkReference` as `cld kit sdk`;
there is no SDK capability. Reference format version 2 adds these structured
fields without changing script execution. Tests compare the worker surface,
compile examples, execute local examples and enforce the Help corpus budget.

Users create and administer apps. Assistant can program an existing app through
these capability operations:

| Operation | Behavior | Permission |
| --- | --- | --- |
| `kit.app.search` | Universal Search for accessible apps | Read |
| `kit.app.read` | Metadata, revision, entrypoints and file manifest | Read |
| `kit.source.read` | A revision-pinned source window | Use |
| `kit.source.validate` | Check a proposed source batch without saving or executing | Admin |
| `kit.source.apply` | Save a valid source batch atomically | Admin |

The resource type is `kit.app`, addressed by its six-character public ID.
The canonical reader is `app.read`. Search returns selection results, not an
exhaustive app export; use the paginated CLI list for that.

A source read takes `id`, `path`, `expectedRevision` and optional `offset`.
It returns at most 16,000 UTF-16 units, `length`, `complete` and `nextOffset`.
Continue until complete at the same revision before replacing a whole file.
A stale revision fails instead of combining windows from different versions.

Source changes take `expectedRevision`, `upsert` (complete `{ path, content }`
files), `delete` (paths) and `edits` (`{ path, offset, deleteCount, content }`).
Each path appears in one operation only; omitted files and app metadata remain
unchanged. Range offsets count UTF-16 units in the expected revision. The entire
resulting project must pass syntax, imports and entrypoint validation. Runtime
code is not executed. Capabilities have a 256 KiB JSON transport limit; use
focused edits and small valid batches for large files. CLI pull/push supports
full project transfers within the existing Kit limits.

Apply has a read-only review showing the app, revision and affected files. It is
a destructive, closed-world Action with no automatic retry after an unknown
outcome. It rechecks current permissions and revision while holding the project
lock. Reconcile by reading the current revision and source before retrying.
Saving never launches code. No capability grants browser storage access or app
sharing, deletion or database reset authority. Creation and metadata changes use the separate app Actions.

The CLI adds `manifest`, `update`, `source read`, `source validate` and
`source apply`. JSON inputs use the standard `--input`, `--input-file` and
`--stdin` conventions. `update` changes only supplied metadata against
`expectedRevision`. The existing access and delete commands provide the complete
administrative workflow. `init --blank` creates a single-tool starter; the
normal initializer creates the CSV workshop.

The Kit overview uses `AppOverview` with responsive app cards, server-side search,
pagination and separate blank/CSV starters. Cards show descriptions and access
levels. Opening a card still requires an explicit Start before execution.

### Markdown pages

Project files may also use `.md`. Each Markdown file appears in app navigation; its first `# Heading` supplies the title, falling back to its filename. The editor offers **Add Markdown page**, the shared Markdown editor, and a live preview. Pages render directly without a worker launch. Existing source read, validate, apply, pull, and push operations handle Markdown with the same permissions, revision guards, and file size limits. Markdown cannot be imported as JavaScript. An app needs at least one script entrypoint or Markdown page.

### Local PDF text

`await kit.pdf.text(file, { onProgress(page, total) {} })` returns
`[{ page, text }]` with one-based pages. PDF.js runs inside the existing,
terminable Kit worker; it does not upload files or render pages. Scanned PDFs
need OCR, which this API does not provide. Input and extracted text are limited
to 16 MiB, and documents to 1000 pages. The host Stop control terminates parsing.
Invalid or password-protected documents reject the call. Missing embedded
character mappings can limit extraction; applications must validate their
format-specific fields rather than treating arbitrary extracted text as data.

## Shared databases and administration

Cloud administrators manage all Kit apps, recover permissions, delete apps, and configure rsql at `/admin/kit`. Shared databases are off by default. Set the private rsql server URL and API token, test the connection, then enable the feature. Tokens are not returned by the settings API. Existing databases and pending cleanup prevent switching servers or removing credentials.

App Settings contains a **Shared database** card. While globally disabled, its checkbox is unavailable and explains that a Cloud administrator must enable the feature. Enabling an app creates one database shared by all its tools and users with Use access. Disabling either switch preserves data. Reset requires confirmation and creates an empty database; scripts must restart. Deleting an app also schedules reliable deletion of its database, including retries while rsql is unavailable. Local data on other users' devices cannot be deleted remotely.

The database panel shows status, tables, records, storage, and the last diagnostics refresh. Counts come from rsql overview and table metadata; they are a diagnostic snapshot, not a transactionally consistent report. Unavailable figures are not displayed as zero.

Use `kit.db.tables`, `kit.db.table(name).rows`, `kit.db.table(name).schema`, `kit.db.query` and `kit.db.importData`. Schema changes require App Admin; row reads/writes require Use. The server binds each operation to the authorized app and database generation. There is no per-row user isolation. SQL accepts a restricted SELECT subset with supported aggregate/string/date/JSON functions; CTEs, comments, internal objects, arbitrary functions and write SQL are rejected. Use pagination and bound parameters.

Imports append rows in sequential batches sized for the request budget. Type inference preserves strings and leading zeros; explicit columns are optional. Creating a missing table requires `createTable: true` and Admin. Existing schema is not silently changed. Imports show one progress toast by default, with cancellation; use `notify: false` or `onProgress` for custom UI. The result reports `confirmedRows`, `totalRows` and `status`. Cancellation keeps completed batches. An ambiguous write yields `unknown`, without automatic replay. Batch replay and durable resume are deferred. Repeating a new import can create duplicates.

Keep concurrency proportionate: a one-person utility usually needs straightforward CRUD and sequential imports, not extra locks, queues or conflict-resolution machinery. For actual shared workflows, use constraints and understand that read-then-write and multiple batches are not atomic transactions. Stopping a script cannot undo a server write that already committed.

The local infrastructure includes the pinned rsql Docker container and persistent volume. It does not make rsql a mandatory production dependency. See `packages/kit/README.md` for development and concurrency guidance, in-app Help for the SDK, and `cld kit db --help` / `cld kit admin --help` for operations.

### UI updates, dialogs and charts

The Alpha UI API uses `set(value)`. There are no legacy setters. Text, buttons,
status and section headings accept text; inputs/selects accept their value;
Markdown accepts source; progress accepts a fraction from zero to one. Setting
an input value does not invoke its `onChange` callback. Metadata methods such as
`setDescription`, `setDisabled`, `setLoading`, `setColumns` and `setState` remain
explicit.

Lists and tables additionally support `upsert(items)` and `remove(ids)`.
An upsert supplies a complete item: existing keys keep their position and new
keys append. List keys are `id`; tables declare `rowKey` and use unique string or
number keys. Missing or duplicate keys reject the update without partial changes.
`remove()` clears displayed items, `remove([])` does nothing, and unknown IDs are
ignored. These methods do not delete the UI element or modify stored data.
Unkeyed tables support `set(rows)` and `remove()`, but not keyed mutations.
File, KV and database deletion APIs retain their explicit storage semantics.

```js
const table = kit.ui.table({
  rowKey: "id",
  columns: [{ key: "title", label: "Task" }],
});
table.set([{ id: "one", title: "First task" }]);
table.upsert([{ id: "one", title: "Updated task" }]);
table.remove(["one"]);
```

Use `kit.ui.modal` for a focused user decision. All dialogs require a visible
`title`. `confirm({title,message})` returns a boolean; cancellation returns false.
`text({title,label,value?})` returns a string or null, and
`number({title,label,value?,min?,max?})` returns a finite number or null.
Text supports `required`, `minLength`, `maxLength` and `multiline`; number supports
`required`. Both can override `confirmText` and `cancelText`.

```js
const values = await kit.ui.modal.dialog({
  title: "New task",
  confirmText: "Add",
  fields: {
    title: { type: "text", label: "Task", required: true, maxLength: 200 },
    priority: {
      type: "select", label: "Priority", default: "normal",
      options: [
        { value: "normal", label: "Normal" },
        { value: "important", label: "Important" },
      ],
    },
  },
});
if (values) console.log(values.title, values.priority);
```

A schema dialog accepts 1–64 named fields of type `text`, `number`, `select` or
`boolean`. Fields require a label and may provide `description`, `placeholder`,
`required` and `default`. Number fields also accept `step`. Select options require
both `value` and `label`; `icon` and `description` are optional. Field names start
with a letter and otherwise contain letters, digits or underscores. Functions
and custom HTML are not accepted. The returned object contains the entered values;
cancellation returns null. Standard labels and validation follow the Cloud locale;
author-supplied strings are unchanged. Stop and navigation close the run's dialog.
Host operations are serialized, so await dialogs before continuing with writes.

`kit.ui.chart({kind,...options})` uses stdlib's JSON option names and the shared
responsive Chart. Call `chart.set({kind,...options})` to replace its configuration.
All 14 stdlib types are available:

| Kinds | Main data shape |
| --- | --- |
| line, scatter | `series: [{label?, data: [{x, y}]}]` |
| bar, pie, donut | `data: [{label, value}]` |
| sparkline, histogram | `data: number[]` |
| boxplot | `groups: [{label, values: number[]}]` |
| gauge | `value`, optional `min`, `max`, `unit` |
| barGauge | `data: [{label, value, min?, max?, unit?}]` |
| stat | `label`, `value`, optional `delta`, `trend`, `sparkline` |
| heatmap | `data: [{x, y, value}]` |
| map | `series: [{label?, data: [{latitude, longitude}]}]` |
| stateTimeline | `rows: [{label, intervals: [{from, to, state}]}]` |

```js
kit.ui.chart({
  kind: "bar", title: "Tasks", showValues: true,
  data: [{ label: "Open", value: 8 }, { label: "Done", value: 12 }],
});
```

Use stdlib's applicable JSON options for axes, legends, reference lines, smooth
lines, areas, thresholds and labels. Line and map charts support `interactive`.
Charts are 18rem high; sparklines are 4rem high and all adapt to their container.
Theme and empty-state labels come from the shared UI. Formatter functions, custom
CSS/classes, links and external resources are excluded. Color overrides accept
hex colors or named colors. Each configuration has a total budget of 1000 array
entries, including nested series and points. Keep a text or table explanation
alongside a chart when exact values matter. A workbench with empty `controls`
uses the full content width.

## SQL console

The built-in /app/kit/:id/database page provides a table/schema browser,
an SQL-highlighted editor without completions, bounded SELECT results and CSV
export. Its sidebar entry appears when the app database is enabled. Database
operations use the same generation-bound service as scripts and CLI.

Shared queries live in kit.saved_queries in Postgres, independently of
rsql reset and activation. Use can list, read and execute; Admin can create,
update, rename and delete. Updates and deletes require the exact revision.
The paginated /api/kit/projects/:id/queries API and cld kit queries
commands share this service. Query text is limited to the existing 16,000
character SQL budget; names to 120 characters. No results or personal history
are persisted. App deletion cascades to saved queries.

One trailing SQL semicolon is accepted by the shared SELECT validator.
All other SQL restrictions, generation checks and request/result limits remain
in force. See registered Help kit-sql-console for user workflows.

Saved query listing accepts an optional exact `name` filter. Create and rename serialize on the app and reject name collisions; updates and deletes still require the exact revision. The SQL console confirms replacement of an existing named query before submitting its revision-bound update.

Kit capabilities separate structured reads (`database.read`), SELECT queries (`database.sql` with `id`, `generation`, `sql`, `params`) and reviewed structured mutations (`database.write`). The former `database.read` query operation is removed. Script `kit.db.query` and the CLI database call remain unchanged. SQL uses the same bounded SELECT validator and Use permission checks; it cannot execute writes.

### Assistant app lifecycle

`kit.app.create` accepts `name`, `description` and optional `databaseEnabled`.
It creates a private app with a README page and Admin access for the caller.
`kit.app.update` accepts an app `id`, exact `expectedRevision`, and optional
`name`, `description`, `databaseEnabled`. Unspecified fields and source remain
unchanged. These Actions return app metadata and database state. Database intent
and app metadata commit together; provisioning uses the existing durable
reconciliation mechanism. Pending provisioning is not a reason to create another
app. Operator-disabled RSQL rejects activation before changing the app.

Both Actions support remembered approval: creation is scoped to app creation,
settings to the exact app. Source replacement and database mutations retain
per-call review; their current contracts include irreversible effects.
No app deletion, database reset, permissions or automatic launch are exposed.
Custom table columns must omit the rsql-managed `id`, `created_at`, `updated_at`.
SQL binds exactly one parameter for each unquoted `?` placeholder.

The in-app `kit-crud-example` is a complete shared-database starter with dialogs,
filtering and pagination. `rows.list` always returns an array in `data`, including
an empty array for no matches. For individual SDK methods, agents can read the
exact level-two Help heading to retrieve its signature, result and example.
