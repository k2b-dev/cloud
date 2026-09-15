---
name: assistant-code-mode
description: Inspect and transform unfamiliar data, analyze files, compare results across Cloud apps, or build and improve interactive apps and reusable scripts in Assistant Studio. Use for quick code experiments, data analysis, file generation, resource SQL queries and combining discovered Cloud capabilities. For plain arithmetic or date offsets, answer directly or use calculate. Work on existing Kit resources belongs to cloud-kit.
---

# Assistant code mode

Choose the smallest useful result: direct answer, one-off script, exported file,
saved script for reuse/sharing, or app for interactive controls. Use an existing
Cloud feature when it already answers the question. For a quick look at an
uploaded PDF or Office file, `read_file` can return converted Markdown without
code. Use the original with code when exact cells, types, or PDF positions matter.

## Keep a working plan

For work with several real steps, use `todo_write` to keep a short chat plan.
Replace the full `todos` list each time; give each item a stable `id`, actionable
`content`, and `status` (`pending`, `in_progress`, `completed`, or `cancelled`).
At most one step is active. Update as work changes, including user corrections;
mark a step completed only after doing and checking it. Preserve exact commands
when they matter. Skip this tool for a simple calculation or conversational reply.

For an app, useful steps are inspect inputs, implement, and verify actual output
and interactions. Saving or compiling code does not complete verification.

## Explore quickly, build from evidence

For a clear small experiment, load `code_run` through `load_tools` and pass
`{"code":"export default () => ({ unique: [...new Set([3, 8, 8, 12])] })"}`.
No written plan, app creation, title, save step or GUI reference is required.
Write a fresh short script for the next question when that is simpler. Variables
are not shared between runs. Pass inputs again; preserve useful files with
`code_export`. Its returned path/version can be passed to `code_write` as
`fromChatFile`, or its path can be the next run's `inputPaths` entry.

Before substantial implementation, identify the desired result and consequential
unknowns. Inspect existing files, source, contracts, or a small read-only sample.
Ask only for missing examples or decisions you cannot resolve yourself. Choose
reasonable reversible defaults for minor details; do not wait for every possible
question to disappear. Use failed experiments to change the hypothesis, not to
repeat the same call. Read [Investigation](references/investigation.md) only when
unfamiliar data or a cross-app workflow needs more guidance.

## First file script

Use exact current-chat paths from the supplied file manifest as `inputPaths`.
For a small CSV, pass this entry as `code`:

```js
export default async () => {
  const [input] = await files.list();
  if (!input) throw new Error("Select a CSV input.");
  const rows = await sheet.fromCsv(await files.read(input.name));
  return { rows: rows.length, columns: Object.keys(rows[0] ?? {}), sample: rows.slice(0, 3) };
};
```

`files.list()` entries use the full leading-slash path as `name`, for example
`"/umsaetze.csv"`. Pass that exact name to `files.read`; do not compare it with
a basename or invent a directory. Inspect the returned CSV column names before
writing joins or calculations; month-level data may have `monat` instead of a
day-level `datum`.

`files.read` returns a `File`, not bytes. `sheet.fromCsv` returns **data rows**
keyed by header names: `rows[0]` is the first record, not the header; do not
remove it with `slice(1)`. For older Excel CSVs use
`await sheet.fromCsv(file, { encoding: "windows-1252" })`.
[Runtime and files](references/runtime.md) covers other decoding options.
For XLSX use `sheet.openExcel(file)`; for PDF use `pdf.open(file)`. Read
[Documents](references/documents.md) for their small handle APIs and close them
in `finally`. [Runtime and files](references/runtime.md) covers limits/exports.
Chat attachments are already uploaded. Local originals stay local through the
user's picker; never require upload when it contradicts the request.
In app tests, explicit `inputPaths` supply picker fixtures; app `files.list/read`
still cannot access chat files.

Short entries have a 15-second readiness watchdog, excluding pending input
reads. For long processing, use `const job = work.run(async context => { /* ... */ });
return await job.done;` in a script; read [Background work](references/work.md).
GUI callbacks launch the job without awaiting `done`. The tool-call budget is
separate; [Debugging](references/debugging.md) explains deadlines and I/O waits.

## Load only what the task needs

For new interactive analysis views, use the built-in UI from
[Analytics UI](references/analytics.md). Load `assistant-data-analysis` for
source validation, metric interpretation, and report/dashboard delivery.

- **Resource data:** `code_sql` runs SELECT directly. For an app-specific experiment,
  import, migration or export, use `code_run({ code, resourceId })` with Manage access;
  [Database](references/database.md). Combine scripts and apps without saving helper scripts.
- **External HTTPS APIs and secrets:** [HTTP and personal secrets](/skills/assistant-code-mode/references/http.md). Use `http.fetch` and `secret()` references; collect keys only with the trusted `code_secret` tool.
- **Cloud operations:** discover the actual capabilities and contracts, then
  use `capabilities.run` in code; [Capability calls](references/capabilities.md).
- **Saved script or app:** [Source workflow](references/source-workflow.md).
  Read existing source before editing; `code_write` atomically saves a file batch against `expectedRevision` and
  preserves sibling files. Use the returned six-character resource short ID. Use `code_list` with `q`
  and `code_read` to find/reuse existing work; fork only for an independent copy.
- **Interactive app:** before the first source write, read [Source workflow](references/source-workflow.md) and the closest [complete example](references/examples.md). Additionally read [UI and dialogs](references/ui.md).
  Use `ui.stat` for numeric KPIs and `ui.chartExplorer` for inspectable charts.
  Test returned control IDs with `code_interact`, including file-picker fixtures.
- **Optional APIs:** [Storage](references/storage.md), [Charts](references/charts.md),
  [Money](references/money.md), [Finance formats](references/finance.md), [PDF generation](references/pdf.md), [Publishing and access](references/publishing.md).
  [Examples](references/examples.md) provides complete starters when needed.

Runtime namespaces are globals; only relative imports of your own source files
are supported. No package installation. All `code_*` tools are direct Assistant
tools, not capabilities; load them individually. Use `capabilities.run` for
other Cloud apps. Shared writes and capability actions are real even in tests,
with normal permissions and approvals. Temporary local storage does not undo them.

## Verify and deliver

Run/interact return errors, logs, UI state, output and captured files. When
`work.status` is `running`, use `code_inspect` with `waitMs` until completion;
do not inspect merely to repeat a finished snapshot. Correct failures and check
that the result actually answers the user's question, with relevant sources,
units, and limitations. A sample does not prove full coverage. `outputTruncated`
means the displayed output is incomplete; return a summary or export a file.

To deliver a CSV, call `await files.save(sheet.toCsv(rows), "result.csv")`
**inside** the script. Then load and call the **tool** `code_export` with the
returned `runId` and file name; finally `present` its returned chat path.
`files.save` returns no path; `code_export` is not a function inside scripts.
CSV export defaults to semicolon, UTF-8 BOM and safe spreadsheet cells.
For analysis, reconcile input/output row counts and exclusions before reporting totals.
Open GUI apps with `code_open`; saved scripts
are available in Studio. Old finished one-offs without files/UI are reclaimed
when slots are needed. Stop unneeded runs holding UI, jobs or captured files.
Test the saved revision, not a rewritten copy of its calculation: the returned
`revision` must equal the revision you intend to deliver. Large validated data
belongs in an exported file imported with `fromChatFile`, not copied from output.

Agent execution runs on the Assistant server in an isolated host; closing or
suspending the user tab does not stop it. `code_open` and `code_secret` still use
the user interface. A lost server host is never replayed automatically. For `kind: "input"`, fix the tool arguments. For `kind: "host"`,
diagnose the host rather than rewriting app source. Never claim an unexecuted
or incomplete result is verified. Keep user-facing progress, errors, and labels
clear; do not introduce decorative UI or a saved resource just to explore.
