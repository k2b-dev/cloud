---
name: assistant-code-mode
description: Build apps and work with data in code. Use whenever the person asks for an app, calculator, converter, timer, form, tracker, dashboard or any other tool they will interact with (always a saved Studio App), and for data analysis, file transformation and generation, resource SQL queries, quick code experiments and combining discovered Cloud capabilities. For plain arithmetic or date offsets, use calculate. A few values that did not come from code use the chart tool; computed charts and tables use cloud.view.*.
---
# Assistant code mode

Choose the smallest useful result: a one-off answer, a view, an exported file,
or a Studio App. Anything the person will interact with is a Studio App, even
when it keeps no data; views only show a result. An App has an HTML interface,
agent actions, or both; persistence is optional. One-off scripts stay in their
chat and cannot be shared. Reuse an existing Cloud feature when it fits. For a
quick reading of an uploaded PDF or Office document, `read_file` can return
Markdown; use code for exact cells, calculations, original PDF text or positions.

There are two kinds of code:

- **Scripts** have no interface: analysis, reports, PDFs, app actions and
  scheduled runs. One JavaScript module, run with `code_run`.
- **HTML apps** are interfaces: `index.html` plus optional `style.css` and
  `app.js`, shown with `code_open` or `code_present`. For a small app follow
  the fast path below; otherwise read [HTML apps](references/apps.md) before
  writing one. Write `steps.json`, run
  `code_check`, fix its errors and layout warnings, look at every screenshot
  and PDF with `view_image` and the report's review prompt, fix and check again
  before `code_open`, `code_present` or `code_publish`. The check uses throwaway
  data; scripts still use real data.

## Build an app the person asked for

An app, calculator, converter, timer, form, tracker or any other tool the
person will use is a saved Studio App: it appears in their Studio Apps, and
they can reopen, change and share it. Never answer such a request with a view
or a one-off chat card.

First decide which kind it is:

- A **small tool** has one screen and keeps at most the person's own settings
  or history, such as a calculator, unit converter, tip calculator or timer.
  Build it in one pass, as below.
- Any other app collects records, involves several people, creates a PDF or
  reads uploaded files, such as a form, list, tracker or generator. A form
  always stores what is submitted, and records that several people add or see
  go into a table: create it with `code_database` and write rows with
  `cloud.db`, never `cloud.kv.user`, which only the person who entered them
  sees. First read [HTML apps](references/apps.md),
  [Source workflow](references/source-workflow.md), the closest complete
  [example](references/examples.md) and the references it uses, such as
  [Database](references/database.md) or [PDF generation](references/pdf.md).
  Then create it with its first `html` and `steps`, and fix and check again
  until the check passes; the one-correction limit below is only for small
  tools.

A small tool in one pass:

1. Load `code_create`, `code_write`, `code_check` and `code_open` with one
   `load_tools` call if they are not loaded yet. Read no references, write no
   plan and run no exploratory code.
2. Call `code_create({title, icon, html, steps})` once with the complete app:
   one `index.html` with its script in `<script type="module">` and its CSS in
   `<style>`, plus its `steps.json`.
3. Call `code_check({id})` once, then `view_image` with the report's
   `review.prompt` for every path in `review.paths`, all in one turn. Fix only
   errors and defects that break use, such as a wrong result or a clipped
   control, not matters of taste, with one `code_write`, then check again.
   Make at most this one correction: open the app once a check passes.
4. Call `code_open({id})`; use `code_present({id})` instead when the person
   asks to see the app in the chat. Then say in one or two sentences what the
   app does.

The single file follows these rules:

- Start with one `<h1>`. Cloud styles plain semantic HTML (headings, forms,
  buttons, tables, `output`) in light and dark with enough contrast. Write
  little CSS: no text or background colors of your own, borders, cards or
  shadows; use tokens such as `var(--k2b-text-muted)` where you must. Use
  `class="row"` or `class="grid"` for layout and `class="primary"` for the
  main button.
- A layout of your own, such as a keypad grid, sets `gap` and
  `> * { margin: 0 }`; otherwise Cloud's spacing between siblings shifts the
  second item of a row.
- No inline handlers (`onclick="…"`), `alert`, `confirm`, `prompt`,
  `localStorage`, `fetch`, CDN scripts or `<link>`. Use `addEventListener`,
  and `await cloud.kv.user.get/set` for what the person keeps, such as
  settings or a history.
- Every button that does not submit a form has `type="button"`; a form
  handles `submit`. Give every control a visible label or `aria-label`.
- Format numbers with `Intl.NumberFormat(cloud.locale)`; write all visible
  text in the person's language.
- `steps.json` holds 1 to 20 main-flow steps that end in the typical used
  state, such as `[{"action":"click","target":{"role":"button","name":"7"}},
  {"action":"click","target":{"role":"button","name":"+"}}]`. Actions are
  `click`, `check`, `uncheck`, `fill`, `select`, `press`, `upload` and
  `reload`; targets are `{role,name}`, `{label}` or `{text}`.

## Start from the contract

Load the needed `code_*` tools individually through `load_tools` and read their
input schemas. They are Assistant tools, not capabilities or functions inside
code. Discover other Cloud operations before using `cloud.capabilities.run`.

Read [cloud contract](references/cloud.md) first: it is the complete runtime contract.
One frozen global `cloud` supplies storage, data, AI, HTTP, files, document
helpers, money, and charts, the same in scripts and apps; only `cloud.view`
works in script runs alone. Only relative source imports are supported, and
there is no native networking. Discover external capability and HTTP contracts
separately.

Inspect supplied data before joining, filtering or calculating: column names,
types, units, date ranges and missing values. Ask only for decisions or inputs
that cannot be established from available evidence. For several real steps,
keep a short `todo_write` plan and update it as work changes; skip ceremony for a
small experiment. A failed experiment should change the next hypothesis.

## First file script

Pass exact current-chat manifest paths as `code_run.inputPaths`, and this entry
as `code_run.code` for a small CSV:

```js
export default async (_input, { files }) => {
  const [input] = files;
  if (!input) throw new Error("Select a CSV input.");
  const rows = await cloud.sheet.parseCsv(await input.file());
  return { rows: rows.length, columns: Object.keys(rows[0] ?? {}), sample: rows.slice(0, 3) };
};
```

`input.path` is the full selected chat path. CSV objects are data rows keyed by
headers; keep the first object. Encoding and numeric conventions are detected;
verify representative names and amounts. Dates and leading-zero codes stay text.
For a tiny experiment without files, `export default () => ({answer:42})` suffices.
Each run has fresh variables. No saved resource or interface is required.

## Reference routing

Read only the rows relevant to the task. Each link describes its own complete
supported surface; links within references add related workflows when needed.

| Task / API | Read |
| --- | --- |
| Script context, input/output files, CSV, IDs | [Runtime and files](references/runtime.md) |
| Inspect PDF pages, read PDF text/positions or XLSX/ODS cells, write ODS | [Documents](references/documents.md) |
| Generate a PDF, save one in Files, embed attachments, combine invoice HTML and XML | [PDF generation](references/pdf.md) |
| Exact amounts, taxes, allocation, localized money | [Money](references/money.md) |
| Export DATEV bookings or SEPA transfers | [DATEV and SEPA](references/finance.md) |
| Parse a CAMT bank report | [Bank reports](references/camt.md) |
| Calculate, create or read electronic invoices/XML/PDF attachments | [Electronic invoices](references/einvoice.md) |
| Interfaces: files, styles without CSS, sandbox rules, dialogs | [HTML apps](references/apps.md) |
| Show an app in this chat | [Chat apps](references/chat.md) |
| Computed charts and tables | [Views in the chat](references/views.md) |
| Chart types, series and axes | [Charts](references/charts.md) |
| Long processing, progress, cancellation | [Script context](references/runtime.md) |
| Persist personal/shared JSON or shared files | [Storage](references/storage.md) |
| Copy files between stores; list and download Filesv2 beside Grids documents | [File transfers](references/files.md) |
| Resource SQL, schema, row CRUD, imports | [Database](references/database.md) |
| Generate text, classify data or extract structured fields | [AI calculations](references/ai.md) |
| Discovered Cloud queries/actions | [Capability calls](references/capabilities.md) |
| External HTTPS and personal secrets | [HTTP and secrets](references/http.md) |
| Call a published App action; declare handlers | [App actions](references/app-actions.md) |
| Reuse work across chats, create or edit an App | [Source workflow](references/source-workflow.md) |
| Publish, restore, copy | [Publishing](references/publishing.md) |
| Find recipients or change App/Skill sharing | [Access](references/access.md) |
| Inspect, export, clear server data, or delete an App | [Management](references/management.md) |
| Execute, inspect, export, stop, diagnose errors | [Run and debug](references/debugging.md) |
| Unfamiliar inputs or cross-app investigation | [Investigation](references/investigation.md) |
| Complete app and script starters | [Examples](references/examples.md) |

For a new app beyond the small-app fast path, read Source workflow and the
closest complete example before writing source, plus only the API references it
uses. For analytical reports or dashboards, also load `assistant-data-analysis`
for metrics and source validation.

## Choose the delivery

Choose by where the values came from:

1. A few values already in the conversation, a web page or a small capability
   result, without a run → `chart` tool.
2. Numbers from code (files, CSV, Cloud data or capability results read with
   `cloud.capabilities.run`) → `cloud.view.chart`, `cloud.view.group`,
   `cloud.view.table`, `cloud.view.stats`, `cloud.view.details` or
   `cloud.view.explorer` in the run, then `present({path})` per view. Never retype run values into tool
   arguments, `data.js` or Markdown; a chat app's `data.js` is the module the run
   wrote, copied unchanged. If a view is missing, rerun with
   `cloud.view.*`. Return only key figures the answer text mentions.
3. 1..6 comparable key figures → `cloud.view.stats` above charts, instead of
   several cards or stat charts. One record with exact fields, such as a checked
   invoice → `cloud.view.details`. Cloud objects found by a script → table `ref`
   columns instead of Markdown links. More records → `cloud.view.table`.
4. Filtering, steps and comparison over a computed dataset → `cloud.view.explorer`;
   no app. For categorical CSV or spreadsheet analyses where the reader will
   compare and filter (status per category, price against stock), deliver
   `cloud.view.stats` key figures plus an explorer over the rows instead of
   isolated single-distribution charts or an offer to build a filter app.
5. Anything the person interacts with beyond an explorer (inputs, what-if,
   own layout, forms), and kept data, live loading, reuse, sharing or actions
   → Studio App; see "Build an app the person asked for".
6. A file as the result → `cloud.download`, `code_export`, `present`.

A successful run is visible to the agent only; present its views or files
before saying the person can see them. Put related measures in a group; use
`linkX` for line charts over the same kind of x. There is no second y axis:
keep different units in separate charts. Read [Views in the chat](references/views.md).

For a Studio App: `code_create` with the first `html` and `steps`, one
`code_write` per further file, then `code_open` beside the chat or
`code_present({id})` in it. Send the writes one at a time, pass each returned
revision as the next `expectedRevision`, and check that each file's `lines`
matches what you wrote.

## Verify and deliver

Run the actual source (the saved revision for saved scripts) and check the
result with representative and invalid inputs. Creating, compiling or saving
source does not verify behavior. If `work.status` is `running`, wait with
`code_inspect({runId,waitMs:30000})`; do not restart the job. Errors and
`outputTruncated` are not successful complete results.

Apps do not run in `code_run`; `code_check` renders them on desktop and phone.
Put calculations over real data into a script first and check them there. Read
the diagnostics of `code_create` and `code_write`, which also validate
`steps.json`, and the errors and warnings of `code_check` and `code_present`,
which reject CDN imports, inline handlers, `alert`, `localStorage`, native
`fetch` and missing files. When you deliver an app, say what the person should
look at.

For a CSV, call `await cloud.download("result.csv", await cloud.sheet.toCsv(rows))` inside code;
for a spreadsheet, `await cloud.download("result.ods", await cloud.sheet.toOds(sheets))`.
Then call the **tool** `code_export` with the returned `runId` and captured file
name, and `present` its returned chat path. `cloud.download` returns no path.
Reuse exported data via its path/version rather than retyping truncated output.
Reconcile row counts, exclusions and totals before reporting findings.

Saving does not replace a user's already-running app. Stop runs no longer
needed that retain jobs or output files. Never claim an unexecuted result is
verified.

Agent execution runs independently of the user's tab. Personal and shared storage, database writes and external actions are real, even
in tests. Cancellation and source restore do not undo them. Actions receive no chat files; scripts receive only explicit inputPaths. Use
`code_secret` for credentials, never chat or app fields. Honor normal access
and approval decisions; availability is not authorization for unrelated actions.
