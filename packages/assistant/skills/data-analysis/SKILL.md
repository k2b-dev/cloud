---
name: assistant-data-analysis
description: Analyze source data, explain metrics and comparisons, and build evidence-backed reports or interactive dashboards in Assistant Code Mode. Use for multi-step analysis, data exploration, and dashboards; a simple chart only needs the Code Mode charts reference.
---

# Analyze data and deliver an inspectable result

Start with the question the reader needs to answer. Choose a direct answer,
a one-off analysis, an exported file, or a reusable Studio app accordingly.
Load `assistant-code-mode` for execution and read its `references/analytics.md`
for UI version 2. Loading this skill does not install a library or grant access.

## Establish the data

Identify the actual source, unit of observation, time window, timezone, and
latest complete period. Read files or discover the relevant Cloud capabilities
before selecting fields. External APIs use `http.fetch`; credentials are entered
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
inputs before crossing the UI bridge. Chart Explorer rows identify selectable
entities with stable string keys; derived bins and groups need explicit mark
mappings. Shared keys across charts mean the same entity, not equal values.

Choose the simplest chart that answers the question. Use tables for exact
records, bars for category comparisons, lines for ordered trends, and distributions
for spread. State units, comparison windows, and whether a percent is a fraction
or an already scaled number. Do not imply causation from correlation.

Lead reports with the finding, then supporting evidence and limitations.
Lead dashboards with the important measurements, then trends and diagnostic
breakdowns. Use shared filters only when they affect all claimed views. Keep the
initial view useful without interaction. Avoid unrelated metrics added merely to
fill a grid.

Attach source context to Explorer data: `mode`, `asOf`, `sources`, and relevant
`status`/`note`. A timestamp records when the data was retrieved; it does not prove
that the upstream source is complete. Label partial or fixture data visibly.

## Validate before delivery

Run the actual source with `code_run`. Inspect the result; use `code_interact`
with structured UI events to test filters, chart/table switching, selection,
empty results, and recovery from a failed load. Reconcile displayed values with
the reviewed totals and check that filters describe the data actually displayed.
A successful schema validation does not establish analytical correctness.

Human approval and uncertain HTTP outcomes follow the Code Mode HTTP contract.
Do not replay an external mutation to refresh a chart. Separate local filtering
from external loading; an Apply button can avoid a request for every slider move.

## Save, share, and hand off

Reuse one Cloud resource for later revisions of the same report or dashboard.
Save its source, test that revision, and use the normal Code Mode publication
workflow when publication is requested. Publishing a version and granting reader
access are separate operations. Preserve existing access; a dashboard request
does not authorize broadening it. Personal secrets are never copied to readers.

A published source version is not automatically a frozen data snapshot. A frozen
report must retain the reviewed data explicitly in its authorized resource or
output file. A live app must implement its loader and display the retrieval time;
loading once is not continuous monitoring. No background refresh exists unless
implemented through an appropriate supported workflow.

Return the resource link or exported file, the data timestamp, and material
coverage limitations. Say whether it is a snapshot or reloads from its sources.
If publication fails, retain the tested resource and report the failed stage;
do not claim success or create a different public destination. Sites-specific
hosting, access policies, and editor storage are not part of this Cloud workflow.
