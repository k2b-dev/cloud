---
name: assistant-code-mode
description: Analyze files, transform data, create native chat views, generate documents and combine discovered Cloud capabilities with one-off runner scripts. For lasting Code and schedules use code-authoring. For plain arithmetic or date offsets, use calculate.
load-tools: [code_run]
---
# Assistant code mode

Run a short inline JavaScript/TypeScript module with `code_run`. It executes
on the Code runner (workerd), under the person's permissions and the turn's
approvals, independently of their browser tab. No saved app is required.

For lasting Code (schedules, mail automations, Code pages, their tests and
submitting a version) load `code-authoring`. Studio authoring,
HTML checking/presentation, app storage and Studio RSQL are unavailable in
chat. Do not request Studio tools or pass `id`, `version` or `resourceId` to
`code_run`. The standalone Studio UI remains separate.

## Start from the contract

Read [Runtime and files](references/runtime.md) for limits and
[cloud contract](references/cloud.md) for helpers. The latter also documents
legacy Studio APIs: `cloud.db`, `cloud.kv` and shared `cloud.files` are
unavailable in chat runs. Use application capabilities and chat/Project files.

One-off scripts may import the generated `@sdk` and default-export a function.
SDK methods return domain data directly. `cloud.capabilities.run(name,input)`
returns capability envelopes. Discover the capability before calling it;
normal authorization and action approvals still apply. There is no native
network access. For external HTTPS and personal secrets read
[HTTP](references/http.md).

Inspect representative supplied data before joining, filtering or calculating:
column names, types, units, date ranges and missing values. Prefer small
read-only probes. Writes and external actions have real effects, including in
tests; cancellation does not undo them. Inspect an uncertain effect before
starting again.

For work with several steps, keep a short `todo_write` plan with stable IDs
and at most one `in_progress` step. Update it after verification; leave
blocked work open with its reason.

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

## Choose the delivery

- Values computed in code: create `cloud.view.chart`, `cloud.view.group`,
  `cloud.view.table`, `cloud.view.stats`, `cloud.view.details` or
  `cloud.view.explorer` in the run, then `present({path})` each returned view.
  Never retype run values into tool arguments or Markdown.
- A few values already in the conversation: the `chart` tool can show them.
- A downloadable result: call `cloud.download` in the script, then
  `code_export` with the returned `runId` and captured name, and `present`
  its returned chat path. `cloud.download` returns no path.

A successful run is visible to the agent only until its views or files are
presented. Read [Views](references/views.md) for groups and explorers. Keep
units in separate charts and reconcile counts, exclusions and totals. Use
table `ref` columns for Cloud objects so their authorized resource links stay
with each row; reuse returned references exactly.

## Verify and deliver

Check representative and invalid inputs. If `work.status` is `running`, use
`code_inspect({runId,waitMs:30000})`; do not restart the job. Inspect errors and
`outputTruncated` before claiming a complete result. Export useful intermediate
files explicitly; runs do not share variables. Stop unneeded work with
`code_stop`.

Use `code_secret` for credentials in the trusted web UI. Never ask for their
values in chat, surveys or source. CLI and unattended turns can use existing
chat secrets but cannot open secret entry. HTTP and capability grants still
apply to unattended routine turns; Studio database grants are unavailable.

## Reference routing

| Task | Read |
| --- | --- |
| Runtime limits, input/output files, CSV | [Runtime](references/runtime.md) |
| PDF text, positions, XLSX/ODS, ODS output | [Documents](references/documents.md) |
| PDF generation and attachments | [PDF](references/pdf.md) |
| Exact amounts and taxes | [Money](references/money.md) |
| DATEV and SEPA | [Finance](references/finance.md) |
| CAMT bank reports | [CAMT](references/camt.md) |
| Electronic invoices | [E-invoice](references/einvoice.md) |
| Native views and charts | [Views](references/views.md), [Charts](references/charts.md) |
| AI calculations | [AI](references/ai.md) |
| Cloud queries/actions | [Capabilities](references/capabilities.md) |
| External HTTPS and secrets | [HTTP](references/http.md) |
| Cross-app investigation | [Investigation](references/investigation.md) |
| Run errors, cancellation and retained results | [Debugging](references/debugging.md) |
| Chat and Project file references and reviewed transfers | [Files](references/files.md) |
| Worked scripts and legacy Studio examples | [Examples](references/examples.md) |

The following references describe legacy standalone Studio behavior. They do
not enable Studio authoring, storage, database or HTML tools in chat. Use
`code-authoring` for lasting Code instead:

- [Studio apps](references/apps.md), [published actions](references/app-actions.md) and
  [legacy chat presentations](references/chat.md).
- [Studio access](references/access.md) and [management](references/management.md).
- [Studio source workflow](references/source-workflow.md) and [publishing](references/publishing.md).
- [Studio database](references/database.md) and [storage](references/storage.md).

For analytical reports also load `assistant-data-analysis` for metrics and
source validation.
