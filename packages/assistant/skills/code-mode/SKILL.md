---
name: assistant-code-mode
description: Analyze local PDF/Excel folders and uploaded files, calculate results, build calculators and dashboards, or reuse and improve apps and saved scripts in Assistant Studio. Use for quick experiments, inspecting unfamiliar data, comparing results across Cloud apps, one-off code, SQL queries on an Assistant resource database, and combining Cloud operations through capabilities.run. Also use for complex data analysis, simulations, and file generation even when the user does not mention programming. This is Assistant Code Mode; it does not use the separate Kit app. Prefer an existing Cloud feature when it already solves the task.
---

# Assistant code mode

Use the smallest result that solves the user's task. Run a one-off script for
calculations, file conversions, and analysis. Save a script for repeated use or
sharing. Create an app when the user needs interactive controls.

The entry exports one function, optionally async. Return concise data for an
analysis. Runtime namespaces are globals: do not import them or install packages.
Only relative imports from your own source files are supported.

## Work from evidence, keep exploration quick

For a clear calculation or small experiment, load `code_run` and run it directly.
No written plan, app creation, saved script, or GUI reference is required.
One-off code is a scratchpad: write a fresh small script for the next question
when that is simpler than extending the previous one. Each run starts fresh;
pass inputs again and export only files worth keeping. Stop obsolete runs.

Before substantial implementation, identify the desired result and uncertainties
that could change it. Inspect available files, source, contracts, or a small
read-only sample first. Use one-off code to discover facts, not only to build
final deliverables. Ask only for missing representative input or consequential
choices you cannot resolve yourself. Choose reasonable reversible defaults for
minor details. Do not wait for every possible question to disappear.

Use the smallest useful experiment, inspect its result, then build or answer.
If it fails, use the evidence to change the hypothesis instead of repeating it.
For unfamiliar data or cross-app workflows, read
[Investigation patterns](references/investigation.md). Simple tasks can skip it.

## Choose your path

- **One-off calculation:** load `code_run` and pass `{"code":"export default () => ({ answer: 6 * 7 })"}`.
  No app, title, icon, or save step is needed.
- **Analyze uploaded files:** read [Runtime and files](references/runtime.md).
  Pass the selected current chat file paths as `inputPaths` to `code_run`.
  Scripts can read those inputs; GUI apps cannot read chat attachments.
- **Local PDF/Excel folder:** read [Documents](references/documents.md) and [Background work](references/work.md). Keep originals local, process files sequentially, preserve paths and PDF pages.
- **Check existing app data:** load `code_sql` for a direct SELECT.
  Read [Database](references/database.md); no analysis script is needed.
- **Combine Cloud operations in code:** read [Capability calls](references/capabilities.md).
  `capabilities.run(name, input)` is a JavaScript API inside `code_run`, not a
  separately discoverable tool. Discover the target Cloud capabilities normally,
  then call them from the script. This also works for one-off scripts.
- **Reusable script:** read [Source workflow](references/source-workflow.md).
  Create once with `kind: "script"`, keep its ID, write source, and run it.
- **Interactive app:** read [Source workflow](references/source-workflow.md) and
  [UI and dialogs](references/ui.md). Create with `kind: "app"` and useful title,
  description, and icon. Exercise its controls before opening it beside the chat.
- **Use or change an existing resource:** load `code_list` and
  `code_read` first. Keep its ID when editing; use
  `code_fork` for an independent copy when you have direct access.

Load only the tools needed for the chosen path through `load_tools`.
All Code Mode tools use `code_*` names. They are direct Assistant tools, not
Cloud capabilities.
Use `capabilities.run(...)` for capabilities of other Cloud apps, not code tools.
`code_write` saves immediately. Read existing source before editing;
write complete file contents and preserve unrelated files.
Keep the complete returned resource UUID. Do not shorten it or use Kit tools
for an Assistant app or script.

## Verify and deliver

`code_run` returns output, errors, logs, UI state, and captured files. A `work.status` of `running` needs `code_inspect` with `waitMs` until completion. Do not
inspect again just to repeat that snapshot. Correct compilation or runtime
errors, rerun, and check the requested behavior. For interactive apps, use
returned control IDs with `code_interact`. Stop obsolete runs.

Runs use temporary local storage. Shared data, database writes, and capability
calls have real effects; test with suitable records and respect approvals.

For a one-off task, deliver findings directly. Export captured output using
`code_export` and link the resulting chat file. If using `present`, load that
tool before calling it. Open GUI apps using `code_open`.
Do not build a UI for a task that only needs a result or an output file.

Execution requires a connected browser host or the CLI's headless Chromium host.
A background tab can continue; closing, reloading, or suspending its host can
interrupt work. Never claim execution was verified when only compilation passed.
If a tool reports `kind: "host"`, diagnose that error rather than rewriting
working source or blindly repeating the call.

## Read only what you need next

- [Runtime and files](references/runtime.md): inputs, outputs, CSV, return values.
- [Documents](references/documents.md): local PDF text/pages and XLSX rows.
- [Background work](references/work.md): large folders, progress, cancellation.
- [Storage](references/storage.md): local or shared files and key/value data.
- [Database](references/database.md): lazy connections, SELECT, and structured records.
- [Capability calls](references/capabilities.md): combine Cloud actions and queries.
- [Publishing and access](references/publishing.md): metadata, sharing, versions, restore.
- [UI and dialogs](references/ui.md): controls and forms; apps only.
- [Charts](references/charts.md) and [Money](references/money.md): task-specific APIs.
- [Debugging](references/debugging.md): additional inspection and recovery.
- [Examples](references/examples.md): complete entries when a starter is useful.

Use real supplied data, short labels in the user's language, and meaningful
loading, empty, validation, and error states. Avoid decorative screens and
controls that do nothing. Keep source, storage, and permission decisions small
and explicit; do not invent APIs.
