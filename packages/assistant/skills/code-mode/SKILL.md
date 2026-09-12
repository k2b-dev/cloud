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

## Explore quickly, build from evidence

For a clear small experiment, load `code_run` through `load_tools` and pass
`{"code":"export default () => ({ unique: [...new Set([3, 8, 8, 12])] })"}`.
No written plan, app creation, title, save step or GUI reference is required.
Write a fresh short script for the next question when that is simpler. Variables
are not shared between runs. Pass inputs again; preserve useful files with
`code_export`. Its returned chat path can be the next run's `inputPaths` entry.

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

- **Resource data:** `code_sql` runs SELECT directly; [Database](references/database.md).
- **Cloud operations:** discover the actual capabilities and contracts, then
  use `capabilities.run` in code; [Capability calls](references/capabilities.md).
- **Saved script or app:** [Source workflow](references/source-workflow.md).
  Read existing source before editing; `code_write` saves immediately and
  preserves sibling files. Keep full resource UUIDs. Use `code_list` with `q`
  and `code_read` to find/reuse existing work; fork only for an independent copy.
- **Interactive app:** additionally read [UI and dialogs](references/ui.md).
  Test returned control IDs with `code_interact`, including file-picker fixtures.
- **Optional APIs:** [Storage](references/storage.md), [Charts](references/charts.md),
  [Money](references/money.md), [Publishing and access](references/publishing.md).
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

A connected browser or CLI host is required. Closing/reloading/suspending it
can interrupt work. For `kind: "input"`, fix the tool arguments. For `kind: "host"`,
diagnose the host rather than rewriting app source. Never claim an unexecuted
or incomplete result is verified. Keep user-facing progress, errors, and labels
clear; do not introduce decorative UI or a saved resource just to explore.
