---
name: assistant-data-analysis
description: Analyze source data, explain metrics and comparisons, and build evidence-backed reports or HTML dashboards in Assistant Code Mode. Use for multi-step analysis, data exploration, and dashboards; a simple chart only needs the chart tool.
---

# Analyze data and deliver an inspectable result

Start with the question the reader needs to answer. Choose a direct answer, a
chart, an app shown in this chat, an exported file, or a reusable Studio app
accordingly. Just data → `chart` tool; interaction → chat app (`code_present`);
persistence or reuse → saved Studio App. A chart of reviewed numbers goes to the
`chart` tool, which draws it in the chat with a data table and needs no app.
Filters and buttons for a one-time analysis belong in a chat app; only data
that must be kept or an app that is used again needs a saved Studio App. Load
`assistant-code-mode` for execution and read its
`/skills/assistant-code-mode/references/apps.md` and
`/skills/assistant-code-mode/references/charts.md` for interfaces and charts.
Loading this skill does not install a library or grant access.

## Keep a working plan

For work with several real steps, use `todo_write` to keep a short chat plan.
Replace the full `todos` list each time; give each item a stable `id`, actionable
`content`, and `status` (`pending`, `in_progress`, `completed`, or `cancelled`).
At most one step is active. Update as work changes, including user corrections;
mark a step completed only after doing and checking it. Preserve exact commands
when they matter. Skip this tool for a simple calculation or conversational reply.

For analysis, useful steps are reconcile source data, build the analysis, and
verify totals, filters and conclusions. A rendered dashboard alone is not proof
that its numbers are correct. Keep blocked source work open and explain why.

## Establish the data

Identify the actual source, unit of observation, time window, timezone, and
latest complete period. Read files or discover the relevant Cloud capabilities
before selecting fields. External APIs use `cloud.http.fetch`; credentials are entered
only through the trusted `code_secret` dialog.

Inspect a bounded sample, missing values, duplicate keys, types, and coverage.
Reconcile totals and join cardinalities before drawing conclusions. Keep raw
numbers separate from display formatting. Distinguish zero from unavailable data;
state exclusions and denominator choices. Do not substitute fixture data for a
blocked source unless the user requested a mockup.

Keep the source query or transformation in the saved source or an accompanying
file so another run can reproduce the result. Preserve the source identity and
retrieval timestamp, without credentials or credential-bearing URLs.

## Build one consistent analysis

Derive charts, metrics, and tables from the same reviewed data. Aggregate large
inputs in a script before they reach an app; an app shows aggregates, not raw
exports. Give exact values a table, for example in a `<details>` element under
the chart.

Choose the simplest chart that answers the question. Use tables for exact
records, bars for category comparisons, lines for ordered trends, and distributions
for spread. State units, comparison windows, and whether a percent is a fraction
or an already scaled number. Do not imply causation from correlation.

Lead reports with the finding, then supporting evidence and limitations.
Lead dashboards with the important measurements, then trends and diagnostic
breakdowns. Use shared filters only when they affect all claimed views. Keep the
initial view useful without interaction. Avoid unrelated metrics added merely to
fill a grid.

Show the source context in the app: whether it is a snapshot, when the data was
retrieved, its sources, and relevant notes. A timestamp records when the data
was retrieved; it does not prove that the upstream source is complete. Label
partial or fixture data visibly.

## Validate before delivery

Compute in a script with `code_run` and inspect the result. Put the filter and
aggregation logic of an app into a module the script can import too
(`lib/totals.js`), and test it there with filters, empty results and failed
loads. Reconcile the values the app will show with the reviewed totals and check
that filters describe the data actually displayed. A successful schema
validation does not establish analytical correctness. Apps are not rendered in
a test yet; read the static findings of `code_write` and `code_present`, and say
what the person should check.

Validate the logic the app actually uses, rather than pasting its formulas into a
second test script. Keep an independent expectation from the input data: row
counts, unmatched joins, totals and representative boundary cases. For targets,
state their grain (for example month × region) and aggregate each target once;
multiple selected regions must sum their distinct targets. Compare inspected raw
KPI values and plotted series with independent expectations. A formatted value
matching after rounding does not validate the raw ratio. Never round fractions before formatting them as percent. Preserve precision
until display formatting. Test reset, one/multiple/all selections, empty results,
and complete versus partial periods. A newly generated timestamp is not source
freshness: keep the real retrieval or file-snapshot timestamp stable.

For a Studio App data snapshot, export the validated dataset with `cloud.download` and
`code_export`, then copy its exact path/version into the App's files with
`code_file_copy` (see the Code Mode file transfers reference); importing private
files into an App receives fresh review. Read it in the app with
`JSON.parse(await (await cloud.files.read("data.json")).text())`. Never rebuild a
truncated dataset by copying tool output. Keep transformations and source
identity alongside the snapshot.

Human approval and uncertain HTTP outcomes follow the Code Mode HTTP contract.
Do not replay an external mutation to refresh a chart. Separate local filtering
from external loading; an Apply button can avoid a request for every slider move.

## Save, share, and hand off

For chat apps, test the numbers with `code_run`, then deliver with
`code_present({title, files})`. A successful run alone is not visible to the
user. Retain source identity, reviewed input data and their real retrieval
timestamp. Put writes and external reloads behind explicit buttons; opening an
old result must not repeat earlier actions. The user can download the current
view as PDF or static HTML.

For reusable Studio Apps, reuse one Cloud resource for later revisions of the same report or dashboard.
Save its source, test that revision, and use the normal Code Mode publication
workflow when publication is requested. Publishing a version and granting reader
access are separate operations. Preserve existing access; a dashboard request
does not authorize broadening it. Personal secrets are never copied to readers.

A published source version is not automatically a frozen data snapshot. A frozen
report must retain the reviewed data explicitly in its authorized resource or
output file. A live app must implement its loader and display the retrieval time;
loading once is not continuous monitoring. No background refresh exists unless
implemented through an appropriate supported workflow.

Present the chat app, resource link or exported file, the data timestamp, and material
coverage limitations. Say whether it is a snapshot or reloads from its sources.
If publication fails, retain the tested resource and report the failed stage;
do not claim success or create a different public destination. Sites-specific
hosting, access policies, and editor storage are not part of this Cloud workflow.
