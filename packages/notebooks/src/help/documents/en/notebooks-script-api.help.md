---
id: notebooks-script-api
title: "Script API"
icon: "ti ti-api"
description: "Complete reference for current, nb, ui, std, KV, tags, and attachments."
order: 160
---

Script blocks expose four globals: `current`, `nb`, `ui`, and `std`. Type a namespace and a dot in a script block to use autocomplete.

**Script API**

## Runtime contract {icon="contract"}

:::reference
- **No imports:** Script blocks use exposed globals only: current, nb, ui, and std.
- **Current notebook boundary:** The nb APIs are scoped to the current notebook. There is no parameter for reading another notebook.
- **Resource ids:** Notebook, note, parent, and attachment ids are the six-character ids used in URLs, APIs, and note:// or attach:// links.
- **Bounded reads:** Structured searches default to limit: 50 and cap at 200. Search can mark large client-side results with __truncated.
:::

**Current note**

## current {icon="file-text"}

### Current metadata

Read properties of the note that contains the script.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `id` | `string` | `current.id` | Short note id. |
| `title` | `string` | `current.title` | Current note title. |
| `content` | `string` | `current.content` | Current Markdown content. |
| `tags` | `string[]` | `current.tags` | Tags parsed from current content. |
| `notebook` | `{ id: string; name: string }` | `current.notebook` | Current notebook identity; id is the public short id. |
| `createdAt` | `string` | `current.createdAt` | Creation timestamp. |
| `updatedAt` | `string` | `current.updatedAt` | Last update timestamp. |
| `lockedAt` | `string \| null` | `current.lockedAt` | Lock timestamp, or null when the note is not locked. |

### Current writes

These methods update the note that hosts the script. Write methods are edit-mode APIs.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `setContent` | `void` | `await current.setContent(markdown)` | Replace the entire Markdown body. |
| `appendContent` | `void` | `await current.appendContent(markdown)` | Append Markdown and keep paragraph spacing readable. |
| `prependContent` | `void` | `await current.prependContent(markdown)` | Prepend Markdown at the start of the note. |
| `insertContentAt` | `void` | `await current.insertContentAt({ line, col? }, markdown)` | Insert Markdown at a 0-based line and optional column. |
| `replaceLine` | `void` | `await current.replaceLine(line, text)` | Replace one 0-based line without changing the rest of the note. |

### Named blocks on `current`

Singular helpers return the first matching named block or undefined. Plural helpers return arrays and can be called without a name.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `table` | `table \| undefined` | `current.table("ideas")` | Read or update a named Markdown table. Writable table views support add(...cells). |
| `tables` | `table[]` | `current.tables(name?)` | List named tables. Omit name to list all table blocks. |
| `list` | `list \| undefined` | `current.list("shopping")` | Read or update a named bullet list. Writable list views support add(...items). |
| `lists` | `list[]` | `current.lists(name?)` | List named bullet lists. |
| `todo` | `todo \| undefined` | `current.todo("tasks")` | Read or update a named task list. Todo items expose done, content, and line. |
| `todos` | `todo[]` | `current.todos(name?)` | List named task blocks. |
| `data` | `data \| undefined` | `current.data("recipe")` | Read or replace a named data block. Writable data views support set(object). |
| `dataBlocks` | `data[]` | `current.dataBlocks(name?)` | List named data blocks. |
| `section` | `section \| undefined` | `current.section("log")` | Read or append to a named Markdown section. |
| `sections` | `section[]` | `current.sections(name?)` | List named sections. |

**Notebook API**

## nb {icon="notebook"}

### `nb` notes

Search and manage notes inside the current notebook.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `list` | `note[]` | `await nb.list()` | List notes in the current notebook. |
| `get` | `note \| null` | `await nb.get(shortId)` | Fetch one note by short id. |
| `search` | `note[]` | `await nb.search(query)` | Search by string or structured query. |
| `searchTags` | `note[]` | `await nb.searchTags(tagOrTags, options?)` | Find notes containing all provided tags. |
| `create` | `note` | `await nb.create({ parentId?, content? })` | Create a note. Its title comes from content; without content the notebook default title template is used. |
| `update` | `note` | `await nb.update(shortId, { parentId })` | Move a note below another note or to the root with null. |
| `remove` | `void` | `await nb.remove(shortId)` | Remove a note by short id. |

### `nb` attachments

Upload, list, insert, and remove attachments scoped to the current notebook.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `list` | `attachment[]` | `await nb.attachments.list()` | List all uploaded attachments in the notebook. |
| `listInNote` | `attachment[]` | `await nb.attachments.listInNote()` | List attachments referenced by the current note content. |
| `get` | `attachment \| null` | `await nb.attachments.get(shortId)` | Fetch an attachment by short id. |
| `upload` | `attachment` | `await nb.attachments.upload(file, filename?)` | Upload a File or Blob. Blob uploads need a filename. |
| `uploadFromPicker` | `attachment[]` | `await nb.attachments.uploadFromPicker({ accept?, multiple? })` | Open the browser file picker and upload selected files. |
| `insertIntoContent` | `void` | `await nb.attachments.insertIntoContent(shortId)` | Append a Markdown attachment link or image reference to the current note. |
| `remove` | `void` | `await nb.attachments.remove(shortId)` | Remove an attachment by short id. |

### `nb` tags

Read the notebook tag index.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `list` | `{ tag: string; count: number }[]` | `await nb.tags.list()` | List all tags used in the notebook with note counts. |
| `notesForTag` | `note[]` | `await nb.tags.notesForTag(tag)` | Find notes that reference one tag. |

**KV**

## State APIs {icon="database"}

### `current.kv`

Collaborative per-current-note state. Calls are synchronous and shared with collaborators.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `get` | `value \| undefined` | `current.kv.get("key")` | Read one key. |
| `set` | `void` | `current.kv.set("key", valueOrUpdater)` | Set one key. The value can be a value or updater function. |
| `delete` | `void` | `current.kv.delete("key")` | Delete one key. |
| `keys` | `string[]` | `current.kv.keys()` | List keys sorted alphabetically. |
| `observe` | `() => void` | `current.kv.observe("key", callback)` | Subscribe to changes for one key and receive an unsubscribe function. |

### `nb.localKV`

Private per-user, per-notebook state. Calls are async and persisted locally in the browser.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `get` | `value \| undefined` | `await nb.localKV.get("key")` | Read one private key. |
| `set` | `void` | `await nb.localKV.set("key", valueOrUpdater)` | Set one private key. |
| `delete` | `void` | `await nb.localKV.delete("key")` | Delete one private key. |
| `keys` | `string[]` | `await nb.localKV.keys()` | List private keys for this notebook namespace. |
| `observe` | `() => void` | `nb.localKV.observe("key", callback)` | Subscribe to same-tab and cross-tab changes for one key. |

**Rendering and interaction**

## ui {icon="layout-dashboard"}

### `ui` layout and content

Build visible output for the script block.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `row` | `element` | `ui.row(...children)` | Horizontal flex row. Children wrap when they do not fit. |
| `col` | `element` | `ui.col(...children)` | Vertical flex column. |
| `card` | `element` | `ui.card(...children)` | Padded visual group for related content. |
| `metric` | `element` | `ui.metric(label, value, options?)` | Compact dashboard metric card. |
| `divider` | `element` | `ui.divider()` | Horizontal rule. |
| `text` | `element` | `ui.text(content)` | Plain paragraph text. |
| `heading` | `element` | `ui.heading(content, level?)` | Heading level 1-6. Default level is 2. |
| `md` | `element` | `ui.md(markdown)` | Render Markdown through the same read-mode engine. |
| `html` | `element` | `ui.html(rawHtml)` | Trusted-script escape hatch. The string is set as raw HTML. |

### `ui` data views

Render notebook data as links, tables, and charts.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `noteLink` | `element` | `ui.noteLink(noteOrShortId, label?)` | Render a clickable link to a note. |
| `noteList` | `element` | `ui.noteList(notes, options?)` | Render notes as a compact note-link list. |
| `table` | `element` | `ui.table(rowsOrTable, options?)` | Render rows or a KitTableView using the notebook table surface. |
| `chart` | `element` | `ui.chart(kind, options)` | Render a stdlib SVG chart. Width is measured from the container; height is configurable. |

### `ui` actions and mounting

Attach actions and mount output.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `button` | `element` | `ui.button(label, onClick, options?)` | Render a button. Async errors are caught and shown inline. |
| `toast` | `void` | `ui.toast(description, options?)` | Show a platform toast. This is not mounted into the script output. |
| `live` | `element` | `ui.live(render)` | Render a small reactive slot. In edit mode it reruns when current note content changes. |
| `render` | `void` | `ui.render(...elements)` | Mount one or more elements into the script output. |
| `show` | `void` | `element.show()` | Every ui element can mount itself into the script output. |

### `ui.prompt`

Open platform prompts from a script.

| API | Returns | Example | What it does |
| --- | --- | --- | --- |
| `alert` | `void` | `await ui.prompt.alert(message, options?)` | Show an informational dialog. |
| `confirm` | `boolean` | `await ui.prompt.confirm(message, options?)` | Show a confirm dialog. |
| `text` | `string \| null` | `await ui.prompt.text(message, defaultValue?, options?)` | Ask for one text value. |
| `form` | `object \| null` | `await ui.prompt.form(spec)` | Ask for multiple values. Fields support text, textarea, number, boolean, and select. |

**Curated stdlib**

## std {icon="library"}

:::reference
- **std.text:** String helpers such as slugify, humanize, truncate, case conversion, and pprintBytes.
- **std.dates:** Date/time formatting and calendar utilities.
- **std.fuzzy:** Fuzzy search and typo correction helpers.
- **std.crypto:** Hashing, UUID/readable ids, asymmetric/symmetric crypto, and TOTP helpers.
- **std.encoding:** Base64, Hex, and Base62 string conversions.
- **std.charts:** Low-level SVG chart generators. Prefer ui.chart for mounted output.
- **std.qr:** QR-code generators and SVG rendering.
- **std.password:** Password generators and strength analysis.
- **std.timing:** Async timing helpers such as sleep, debounce, throttle, jitter, and withMinLoadTime.
- **std.files:** Browser file downloads, ZIP archives, file/folder pickers, and MIME helpers.
- **std.images:** Browser image processing pipeline helpers.
- **std.clipboard:** Script-facing clipboard facade with copy(text).
:::
