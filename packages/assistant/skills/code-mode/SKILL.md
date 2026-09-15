---
name: assistant-code-mode
description: Inspect and transform unfamiliar data, analyze files, compare results across Cloud apps, or build and improve interactive and agent-only Apps in Assistant Studio. Use for quick code experiments, data analysis, file generation, resource SQL queries and combining discovered Cloud capabilities. For plain arithmetic or date offsets, answer directly or use calculate. Work on existing Kit resources belongs to cloud-kit.
---
# Assistant code mode

Choose the smallest useful result: one-off answer, exported file, or reusable
Studio App. Apps may expose agent actions, a display-only dashboard, or both.
Persistence is optional. One-off scripts stay in their chat and cannot be shared. Reuse an
existing Cloud feature when it fits. For a
quick reading of an uploaded PDF or Office document, `read_file` can return
Markdown; use code for exact cells, calculations, original PDF text or positions.

## Start from the contract

Load the needed `code_*` tools individually through `load_tools` and read their
input schemas. They are Assistant tools, not capabilities or functions inside
code. Discover other Cloud operations before using `capabilities.run`.

Runtime namespaces are globals: no imports or package installation are needed.
Only relative imports of the resource's own source files are supported. There is
no DOM or native network access. Before using a namespace, read its reference
below for signatures, options and return values. Do not invent methods or infer
an API from a familiar library. For discovered Cloud capabilities and external
APIs, obtain their actual contracts separately.

Inspect supplied data before joining, filtering or calculating: column names,
types, units, date ranges and missing values. Ask only for decisions or inputs
that cannot be established from available evidence. For several real steps,
keep a short `todo_write` plan and update it as work changes; skip ceremony for a
small experiment. A failed experiment should change the next hypothesis.

## First file script

Pass exact current-chat manifest paths as `code_run.inputPaths`, and this entry
as `code_run.code` for a small CSV:

```js
export default async () => {
  const [input] = await files.list();
  if (!input) throw new Error("Select a CSV input.");
  const rows = await sheet.fromCsv(await files.read(input.name));
  return { rows: rows.length, columns: Object.keys(rows[0] ?? {}), sample: rows.slice(0, 3) };
};
```

`input.name` is the full path, such as `/sales.csv`; pass it unchanged to
`files.read`, which returns a `File`. CSV rows are objects keyed by headers:
`rows[0]` is already data. Do not drop it. For older Excel CSVs, use
`sheet.fromCsv(file, {encoding:"windows-1252"})`. Inspect actual headings first.
For a tiny experiment without files, `export default () => ({answer:42})` suffices.
Each run has fresh variables. No saved resource or UI is required.

## Reference routing

Read only the rows relevant to the task. Each link describes its own complete
supported surface; links within references add related workflows when needed.

| Task / API | Read |
| --- | --- |
| Source entry, input/output files, pickers, CSV, IDs | [Runtime and files](references/runtime.md) |
| Read original PDF text/positions or XLSX cells, write XLSX | [Documents](references/documents.md) |
| Generate a PDF, embed attachments, combine invoice HTML and XML | [PDF generation](references/pdf.md) |
| Exact amounts, taxes, allocation, localized money | [Money](references/money.md) |
| Export DATEV bookings or SEPA transfers | [DATEV and SEPA](references/finance.md) |
| Parse a CAMT bank report | [Bank reports](references/camt.md) |
| Calculate, create or read electronic invoices/XML/PDF attachments | [Electronic invoices](references/einvoice.md) |
| Controls, layouts and dialogs | [UI and dialogs](references/ui.md), [Analytics UI](references/analytics.md) |
| Chart types, series and axes | [Charts](references/charts.md) |
| Long processing, progress, cancellation | [Background work](references/work.md) |
| Persist JSON or files locally/shared | [Storage](references/storage.md) |
| Resource SQL, schema, row CRUD, imports | [Database](references/database.md) |
| Discovered Cloud queries/actions | [Capability calls](references/capabilities.md) |
| External HTTPS and personal secrets | [HTTP and secrets](references/http.md) |
| Call a published App action; declare handlers | [App actions](references/app-actions.md) |
| Reuse work across chats, create or edit an App | [Source workflow](references/source-workflow.md) |
| Publish, restore, copy | [Publishing](references/publishing.md) |
| Find recipients or change App/Skill sharing | [Access](references/access.md) |
| Execute, inspect, interact, export, stop, diagnose errors | [Run and debug](references/debugging.md) |
| Unfamiliar inputs or cross-app investigation | [Investigation](references/investigation.md) |
| Complete app starters | [Examples](references/examples.md) |

For a new app, read Source workflow and the closest complete example before
writing source, plus only the API references it uses. For analytical reports or
dashboards, also load `assistant-data-analysis` for metrics and source validation.

## Verify and deliver

Run the actual saved revision and test relevant controls with IDs returned by
`code_run`/`code_interact`, including invalid inputs and picker fixtures. Creating,
compiling or saving source does not verify behavior. If `work.status` is
`running`, wait with `code_inspect({runId,waitMs:30000})`; do not restart the job.
Inspect only when the returned snapshot needs more detail. Errors and
`outputTruncated` are not successful complete results.

For a CSV, call `await files.save(sheet.toCsv(rows), "result.csv")` inside code.
Then call the **tool** `code_export` with the returned `runId` and captured file
name, and `present` its returned chat path. `files.save` returns no path.
Reuse exported data via its path/version rather than retyping truncated output.
Reconcile row counts, exclusions and totals before reporting findings.

Open GUI apps with `code_open`. Saving or testing does
not replace a user's already-running app. Stop runs no longer needed that retain
UI, jobs or output files. Never claim an unexecuted result is verified.

Agent execution runs independently of the user's tab. Agent local storage is
temporary; shared storage, database writes and external actions are real, even
in tests. Cancellation and source restore do not undo them. Apps select local
files explicitly; they never gain implicit access to chat attachments. Use
`code_secret` for credentials, never chat or app controls. Honor normal access
and approval decisions; availability is not authorization for unrelated actions.
