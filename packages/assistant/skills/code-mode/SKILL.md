---
name: assistant-code-mode
description: Use code to analyze, calculate, transform, and generate files or data, or build interactive apps in Assistant. Use for complex calculations, combining datasets, cleaning or converting files, custom analyses, simulations, calculators, trackers, and dashboards—even when the user does not mention programming. Also use to fix or extend an existing Assistant app. Prefer an existing Cloud feature when it already solves the task.
---

# Assistant code mode

Choose the simplest useful result. For a one-off analysis, return findings and
output files without building a UI or opening an app tab. Build an interactive
app when controls or repeated use help the user. Both run in the same isolated
JavaScript or TypeScript worker and require a connected Assistant browser.

## Fast path

The entry exports one function. `ui`, `files`, `sheet`, `store`, `opfs`, `ids`,
and `money` are already available as globals: **do not import them**. Imports are
only for relative helper files you wrote. There are no packages to install.
Return plain data for an analysis. For a UI, create controls and layouts without
returning their handles.

Do not read every reference before starting. Choose one path:

- **Calculate or transform data:** read [Runtime and files](references/runtime.md)
  only when using files. A complete entry can be as small as
  `export default () => ({ answer: 6 * 7 });`.
- **Build an interactive app:** read [UI and dialogs](references/ui.md).
  Read charts or money only if the task needs them. Use
  [Examples](references/examples.md) when a starter helps.
- **Fix an existing app:** read its source first; keep the same app ID.

1. Load source and execution tools together:
   `load_tools({"names":["assistant.code_create","assistant.code_read","assistant.code_write","code_run","code_interact","code_stop"]})`.
   Source tools have an `assistant.` prefix; browser tools do not.
2. Create once, retain the returned `id`, and write complete source to its entry
   path. `code_write` saves immediately. There is no save, revision, or approval
   step. Unrelated files remain unchanged. Compilation errors include source
   locations: fix them before running, without creating another app.
3. Run with `code_run`. Its result already contains output, errors, UI state,
   and captured files. Do not call Inspect just to repeat that snapshot.
   Exercise the main interaction using returned IDs; verify the requested
   calculation or output. Fix script errors yourself and run the corrected source.
4. Deliver findings directly for a one-off calculation. For output files, load
   `code_export`, export the captured file, then inspect and present the chat file.
   For an interactive app, load `code_open` and open it beside the chat.
   Opening does not start the user's app. Stop obsolete test runs.

Keep the first implementation small and complete. A simple calculation does
not need a framework, a UI, or its own test framework. Do not add multiple
exploratory tool rounds when the next action is already known.

Load `code_inspect` only for additional detail, and read
[Debugging](references/debugging.md) when needed. If a tool returns
`kind: "host"`, the execution environment failed: do not rewrite source or
repeat the same call unchanged. Report the concrete error. If tools are absent,
report that execution could not be verified. After an uncertain create or write,
read the existing resource before repeating it. Never claim compilation as a
successful runtime test.

## Make the result useful

Put the user's primary task first. A calculator shows inputs and results; a
tracker shows records and their actions. Avoid introductory marketing screens,
placeholder rows, decorative headings, and controls that do nothing. Keep
empty, loading, validation, and failure states understandable.

Use the supplied components: selects for constrained choices, dialogs for short
forms, lists for actionable records, tables for comparing rows, and charts for
patterns. Choose components from the API reference rather than inventing APIs.
Create controls once and update their handles; keep control and item IDs stable
so interactions remain testable. Support narrow layouts with the supplied layout
primitives. UI snapshots verify behavior; they are not proof of visual quality.

Write app text in the user's language. Keep labels and messages short and useful;
do not describe workers, source revisions, or implementation details to end users.
Build the requested scope completely without adding speculative features. Use
real supplied data when available; label sample data clearly and keep it separate.

## Read the needed reference

- [Source workflow](references/source-workflow.md): file tools, identity, writes,
  removals, and recovery.
- [Runtime and files](references/runtime.md): return values, inputs, outputs,
  CSV processing, and local storage.
- [UI and dialogs](references/ui.md): controls, tables, lists, layouts, and forms.
- [Charts](references/charts.md): chart data shapes and updates.
- [Money](references/money.md): exact amounts, tax, formatting, and allocation.
- [Debugging](references/debugging.md): run, inspect, interact, and export.
- [Examples](references/examples.md): complete headless and interactive scripts.

The entry exports one function, optionally async. Use relative helper imports
and the supplied `ui`, `files`, `sheet`, `store`, `opfs`, `ids`, and `money`
namespaces. There is no package installation, generated DOM, or SQL API.

Apps have independent permissions. A chat link does not share access. Local
storage belongs to this user, app, and browser; test runs do not touch it. For a
mostly single-person tool, use simple state and awaited operations. Add
concurrency handling only for actual overlapping work. A background browser tab stays connected, but closing or reloading the browser
ends its worker sessions. Browser suspension can delay execution. Do not promise
execution after the Assistant browser closes.
