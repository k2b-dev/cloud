---
name: assistant-code-mode
description: Inspect and transform unfamiliar data, analyze files, compare results across Cloud apps, or build and improve HTML and agent-only Apps in Assistant Studio. Use for quick code experiments, data analysis, file generation, resource SQL queries, interactive charts and small apps shown in chat, and combining discovered Cloud capabilities. For plain arithmetic or date offsets, use calculate. To only show data as a chart, use the chart tool.
---
# Assistant code mode

Choose the smallest useful result: one-off answer, exported file, an app shown
in this chat, or a reusable Studio App. An App has an HTML interface, agent
actions, or both; persistence is optional. One-off scripts stay in their chat
and cannot be shared. Reuse an existing Cloud feature when it fits. For a
quick reading of an uploaded PDF or Office document, `read_file` can return
Markdown; use code for exact cells, calculations, original PDF text or positions.

There are two kinds of code:

- **Scripts** have no interface: analysis, reports, PDFs, app actions and
  scheduled runs. One JavaScript module, run with `code_run`.
- **HTML apps** are interfaces: `index.html` plus optional `style.css` and
  `app.js`, shown with `code_open` or `code_present`. Read
  [HTML apps](references/apps.md) before writing one. Write `steps.json`, run
  `code_check`, fix its errors and layout warnings, look at every screenshot
  and PDF with `view_image` and the report's review prompt, fix and check again
  before `code_open`, `code_present` or `code_publish`. The check uses throwaway
  data; scripts still use real data.

## Start from the contract

Load the needed `code_*` tools individually through `load_tools` and read their
input schemas. They are Assistant tools, not capabilities or functions inside
code. Discover other Cloud operations before using `cloud.capabilities.run`.

Read [cloud contract](references/cloud.md) first: it is the complete runtime contract.
One frozen global `cloud` supplies storage, data, AI, HTTP, files, document
helpers, money, and charts, the same in scripts and apps. Only relative source
imports are supported, and there is no native networking. Discover external
capability and HTTP contracts separately.

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
| Show an interactive app in this chat | [Chat apps](references/chat.md) |
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

For a new app, read Source workflow and the closest complete example before
writing source, plus only the API references it uses. For analytical reports or
dashboards, also load `assistant-data-analysis` for metrics and source validation.

## Choose the delivery

Just data → `chart` tool; interaction → chat app (`code_present`); persistence
or reuse → saved Studio App. When the person only needs to see numbers as a
chart, compute them (with `code_run` if needed) and pass them to the `chart`
tool: Cloud draws it in the chat with a data table, no app files or
`code_check`. It takes the options of `cloud.chart()` as plain data.

For a calculator, a filterable chart, a report or small dashboard in this
conversation, compute and check the numbers with `code_run`, then show an HTML
app with `code_present({title, files})`. Read [Chat apps](references/chat.md).
A successful run is visible to the agent only; present it before saying the
user can see it. No saved App or chat file is necessary.

Use a Studio App when the user needs an independently accessible, reusable
application: `code_create`, `code_write`, then `code_open` beside the chat or
`code_present({id})` in it. Use `cloud.download`, `code_export`, and `present`
when the requested result is a file. These are separate delivery choices.

## Verify and deliver

Run the actual source (the saved revision for saved scripts) and check the
result with representative and invalid inputs. Creating, compiling or saving
source does not verify behavior. If `work.status` is `running`, wait with
`code_inspect({runId,waitMs:30000})`; do not restart the job. Errors and
`outputTruncated` are not successful complete results.

Apps do not run in `code_run`; `code_check` renders them on desktop and phone.
Put calculations into a script first and check them there. Read the diagnostics
of `code_write`, which also validate `steps.json`, and the errors and warnings of
`code_check` and `code_present`, which reject CDN imports, inline handlers,
`alert`, `localStorage`, native `fetch` and missing files. When you deliver an
app, say what the person should look at.

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
