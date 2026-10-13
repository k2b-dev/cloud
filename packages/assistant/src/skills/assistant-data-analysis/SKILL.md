---
name: assistant-data-analysis
description: Analyze source data, explain metrics and comparisons, and build evidence-backed reports or dashboards in Assistant Code Mode. Use for multi-step analysis, data exploration, and dashboards; computed charts, tables and one-off dashboards use cloud.view.* in the run, a dashboard to keep, reload or share is a Studio App, and a few non-run values use the chart tool.
---

# Analyze data and deliver an inspectable result

Start with the question the reader needs to answer. Load `assistant-code-mode`
with `load_skill`, not `load_tools`, for execution, delivery and approval rules.
Read its `/skills/assistant-code-mode/references/views.md` for computed charts,
groups, tables, key figures and record details,
`/skills/assistant-code-mode/references/charts.md` for
`cloud.chart()` in apps/PDFs, and `/skills/assistant-code-mode/references/apps.md`
for interfaces. Loading a skill installs no library and grants no access.

Choose a direct answer, views, an exported file or a Studio App by the
question. Computed values stay in `code_run` and reach the reader
through `cloud.view.*` and `present({path})`. Never retype run values into tool
arguments, app data or Markdown. Return only key figures the answer mentions.
If a view is missing, rerun with `cloud.view.*`. A few non-run values use the
`chart` tool. Filters, steps and comparison over a computed dataset use
`cloud.view.explorer`. Interaction an explorer cannot express, and kept data,
reuse, sharing, live loading or actions, need a Studio App.
For categorical CSV or spreadsheet analyses where the reader will compare or
filter (status per category, price against stock), deliver `cloud.view.stats`
key figures plus an explorer over the rows instead of isolated
single-distribution charts or an offer to build a filter app.
A dashboard of an upload that the person does not ask to keep, reload or share
is such views: `cloud.view.stats`, a `cloud.view.group` of charts and an
explorer, presented in the chat. Build no app for it.

## Establish the data

For several real steps, keep a short `todo_write` plan: reconcile sources,
build the analysis, verify results. Replace the full list with stable IDs,
actionable content and statuses (`pending`, `in_progress`, `completed`,
`cancelled`); keep at most one step active. Update
it for corrections, retain important commands, and mark work complete only
after checking it. Skip it for a simple calculation or conversational reply.
Keep blocked source work open and explain the blocker.

Identify the source, unit of observation, time window, time zone and latest
complete period before selecting fields. Read files or discover Cloud
capabilities. For CSV, TSV or spreadsheets, use `read_file` at most for the
first block to learn columns, then select the path with `code_run.inputPaths`
and compute structure, counts and figures in code. Do not page the whole table
into context. External APIs use `cloud.http.fetch`; credentials enter only
through the trusted `code_secret` dialog.

Inspect a bounded sample, types, missing values, duplicate keys and coverage.
Reconcile totals and join cardinalities. Distinguish zero from unavailable data;
state exclusions and denominators. Fixture data may replace a blocked source
only for a requested mockup, and must be labeled visibly.

Keep the query or transformation in saved source or an accompanying file.
Retain source identity and the real retrieval or file-snapshot timestamp,
without credentials or credential-bearing URLs. A timestamp does not establish
upstream completeness; keep it stable when rerendering a snapshot.

## Choose the evidence

Derive charts, metrics and tables from the same reviewed data. Aggregate large
inputs in a script; apps show aggregates rather than raw exports. Use a
`cloud.view.table` for inspectable chat records, or a `<details>` table in an app.
Use `cloud.view.stats` for 1..6 comparable key figures above charts instead of
several cards or stat charts. Use `cloud.view.details` for one record with exact
fields, such as a checked invoice. Use table `ref` columns for Cloud objects
found by a script instead of Markdown links. Choose the chart by the question:

| Question | Chart |
| --- | --- |
| Compare category counts or totals | Bar; sort by value unless categories have their own order. |
| Show ordered trends | Line; several measures over the same time axis use a group with `linkX`, each with its own units. There is no second y axis. |
| Show a continuous distribution | Histogram rows form over all observations, rather than a sample. |
| Compare distributions across categories | Boxplot; observations count toward the mark budget, so check the limits before delivery. |
| Compare two categorical dimensions | Heatmap; aggregate to one value per x/y pair. |
| Compare a few values against capacity | BarGauge; at most 8 items, short labels, meaningful min/max and thresholds. |
| Show one headline number with change | Stat; compute `delta` in the value's units and set `better` only when improvement has a defined direction. |
| Show shares of one whole | Pie/donut for two to four shares; many status counts read better as sorted bars. |

Use `references` for targets or averages. For a last-period comparison, align
periods to comparable x values and put the comparison in a line/scatter series
with `role: "reference"`. Name both windows. Missing observations stay missing;
zero is not a substitute. Color must mean something (series, threshold, a
category the legend names); do not use `colorByBar` to decorate bars the axis
already names. Group related measures;
add no unrelated metrics to fill a grid.

State units and whether percentages are fractions or already scaled numbers.
Keep raw numbers separate from display formatting; never round fractions before
percent formatting. Preserve precision until display. Do not imply causation
from correlation.

Name the measure as computed, such as "Sum of price × stock" or "Number of
products". Check the formula before using a business term: a sum of unit prices
is not stock value. Compare or break down where the question allows it
(status per category, price against stock), rather than showing only isolated
distributions. Include records the reader may need to check.

Lead reports with the finding, evidence and limitations; lead dashboards with
important measurements, trends and diagnostic breakdowns. Shared filters must
affect every claimed view. Keep the initial view useful without interaction.
Show source context: snapshot or live loading, retrieval time, sources and
coverage notes. Label partial data visibly.

## Validate the actual result

Run the analysis with `code_run` and inspect it. Share app filtering and
aggregation in a module a script can import (`lib/totals.js`); test the actual
logic, not a second copy of its formulas. Keep independent expectations from
the input: row counts, unmatched joins, totals and boundary cases. Reconcile
raw KPI values and series before formatting; matching rounded values does not
validate a ratio. Schema validation and a rendered dashboard do not establish
analytical correctness.

For targets, state the grain (for example month × region) and aggregate each
target once; multiple selected regions sum distinct targets. Test reset,
one/multiple/all selections, empty results, failed loads, and complete versus
partial periods. Check that filters describe the data actually displayed.
Use `code_check` on desktop and phone; inspect every screenshot, fix visible
defects and check again before delivery.

For a Studio App snapshot, export the validated dataset through `cloud.download`
and `code_export`, then transfer its exact path/version with `code_file_copy`
(see the Code Mode file transfers reference). Private imports receive fresh
review. Read it with `JSON.parse(await (await cloud.files.read("data.json")).text())`;
never reconstruct a truncated dataset from tool output. Retain transformations
and source identity with the snapshot.

Follow Code Mode's HTTP approval and uncertain-outcome contract. Never replay
an external mutation to refresh a chart. Keep filtering separate from external
loading; an Apply button can avoid a request on every slider move. Put writes
and external reloads behind explicit buttons so opening an old result does not
repeat actions.

## Deliver and retain the result

Present views or exported files; a successful run alone is not visible. A
one-off overview of an upload, even when called a dashboard, is
`cloud.view.stats` plus groups or an explorer. A dashboard the person wants to
keep, reload, share or give to a team is a Studio App, opened with `code_open`
or shown with `code_present({id})` after checking numbers and rendering. The
user can download its current view as PDF or static HTML. The answer carries findings, caveats and decisions, not values
already shown in views. Include the result link/path, data timestamp and material
coverage limits; say whether it is a snapshot or reloads from sources.

Reuse one Cloud resource for revisions of a reusable report or dashboard.
Save and test its source, and follow Code Mode publication when requested.
Publishing a version and granting readers access are separate operations;
preserve existing access. A dashboard request does not authorize broader
sharing, and personal secrets never go to readers.

A published source version does not freeze its data. Frozen reports retain
reviewed data in an authorized resource or output file. Live apps implement
a loader and show retrieval time; loading once is not continuous monitoring.
Background refresh requires an implemented, supported workflow.
If publication fails, retain the tested resource and report the failed stage;
do not claim success or create another public destination. Sites hosting,
access policies and editor storage are outside this Cloud workflow.
