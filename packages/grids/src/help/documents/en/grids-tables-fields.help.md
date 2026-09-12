---
id: grids-tables-fields
title: Tables & fields
icon: ti ti-table
description: Choose field types and manage the lifecycle of saved records.
order: 110
---
A table stores one kind of record. Choose field types for their meaning, not just their appearance.

**Base settings → Tables** lets admins search by name or public ID and compare field/index/unique counts, history, finalization, and write paths. Open a table for its records and settings; this overview does not count records.

## Fields for entered values {icon="table"}

| Field type | Use it for | Important behavior |
| --- | --- | --- |
| Text | Names, codes, email addresses, and short labels | Single-line text; a good default record label |
| Long text | Notes and descriptions | Can display Markdown when configured |
| Number | Quantities, prices, measurements, and exact decimal arithmetic | May show a unit and decimal precision |
| Percent | Percentages | Uses 0–100 by default; a field can instead use a 0–1 fraction scale |
| Boolean | Yes/no facts | Stores true, false, or empty when optional |
| Date | A day or an exact date-time | Date-time values represent a moment; a current-time default uses the time when a new record is saved |
| Duration | Elapsed time | Stored as seconds; accepts seconds, `MM:SS`, or `HH:MM:SS` |
| Select | A value from a controlled list | Options can have labels, colors, and descriptions; a select may allow several values |
| Principal | One or several responsible people or groups | Stores typed Cloud user and group references; the picker shows only identities the current account may discover |
| JSON | Structured data that does not need its own Grids fields | Use sparingly; individual properties are less convenient to filter and explain |
| Object list | Typed rows owned by this record, such as invoice items | Shared validation, calculated columns, and atomic finalization |
| File | Attachments and images | The field controls accepted file types and file count; Grids enforces the configured upload-size limit |

Use **Required** when an empty value would make a record invalid. A **Default** fills a value only when a new record omits that field. Use **Unique** for identifiers that must not repeat, such as an asset code or invoice number.

Date-time display, date-based filters, formulas, exports, and document folders use the browser's timezone when it is available, then fall back to the Cloud application timezone. Date-only values remain calendar dates. Scheduled workflows use the IANA timezone declared in their YAML and default to UTC when it is omitted.

## Fields that connect or calculate {icon="table"}

- **Relation** links one record to one or several records in another table. The target table's record label is shown in pickers and cells.
- **Lookup** displays one field from a related record without copying it.
- **Rollup** summarizes values reached through a relation.
- **Formula** calculates from the current Draft's fields. Finalization freezes the result.
- **HTML template** renders Liquid and optional CSS into one HTML string per record. It can use ordinary fields plus lookup, rollup, and formula results. Values are escaped by default; preview the result before using `raw`.
- **ID** creates a stable generated identifier. Sequence and date-sequence IDs use a durable number series that Grids assigns when the record is created. Values increase atomically and are never reused; rollbacks and technical failures can leave gaps. Changing the prefix or format affects only future records.
- **Created at, Created by, Updated at, and Updated by** are system-managed fields. They describe record activity and cannot be entered as ordinary business values.

Choose a relation when the target has its own details or lifecycle. A customer name typed into every invoice is only text; a Customer relation keeps the invoice connected when the customer's details change.

The live record detail shows up to five **Referenced by** results beside its outgoing Relations. Results are grouped by source table and Relation field; **Load more** fetches the next bounded page. The list follows current read permissions and never adds incoming links to the record's field data.

In the CLI, use `cld grids records referenced-by <table-id> <record-id> --limit 5 --json`. Record comments are available through `records comments list|create|update|delete`; use `--body-file` for Markdown and `--yes` to delete. Both lists accept `--cursor` and return `nextCursor`. These commands use public IDs and preserve the same Base, author, and moderation permissions as the record detail.

Principal values do not grant access. Full accounts can use the directory; guests can select only themselves and their direct/nested groups, not other users or group members. Saving rechecks visibility, including API submissions.

HTML template fields are read-only per-record output, not immutable Documents or PDFs. Tables show escaped source; record details offer a sandboxed **Preview**, never injecting HTML into the record page.

Templates use public field IDs, e.g. `{{ record.data.aB12xZ }}`, with names in autocomplete. Other HTML template fields are unavailable to prevent recursion. These fields require stored tables and do not support filters, sorting, grouping, aggregates, formulas, or relation lookups.

## Formulas in a table {icon="table"}

Use the shared [formula reference](/app/grids/help/grids-formulas) for syntax, examples, and errors. A table formula belongs to each record; a computed query column belongs only to that query.

## Rows inside a record {icon="table"}

Choose **Object list** for items without their own permissions or lifecycle; otherwise use a Relation. Expand **Rules and calculation** for constraints or formulas using sibling columns. Selection columns and regex constraints are input-only. Nested objects, relations, and lists are not allowed inside a row.

Edit rows across 25-row pages without losing changes or valid previews. Saving validates and replaces the list with version protection. Default: 0–100 rows; limits: 1,000 rows, 200 columns, 256 KiB. Removed columns are hidden in drafts without rewriting stored history. Columns containing finalized values cannot be removed.

Use `LIST_SUM(Items, 'Amount')` for a total. `LIST_AVG`, `LIST_MIN`, and `LIST_MAX` use the same arguments; `LIST_COUNT(Items)` counts rows. An empty list sums/counts to zero; other reductions and a missing list return null. Finalization freezes rows and calculated values together, preserving exact amounts and types.

## Search, filters, and indexes {icon="search"}

Text, long text, ids, numbers, percentages, durations, dates, booleans, select labels, and readable relation labels participate in broad search. Use filters for exact conditions and for calculated, lookup, rollup, file, or empty-value rules.

An index helps fields used often for filtering, sorting, search, joins, or unique checks. Every index also adds write work, so add one for an observed access pattern rather than every field.

## Record identity and history {icon="table"}

Choose one short, readable **record label** for every table. It is the title shown in relation pickers and detail panels. A long description is usually a poor label even when it is unique.

If another user or tab changes a record before your edit is saved, Grids rejects the older edit instead of silently overwriting newer data. Reload the record, review the newer values, and apply the change again.

Moving a record to trash is reversible. Restoring it creates a new history event; it does not erase the deletion event.

**Replace** swaps an attachment atomically. **Remove from record** detaches it and logs the actor, time, field and immutable file metadata. Protected revisions or artifacts retain its bytes; unprotected files may be cleaned up. Detachment promises neither physical erasure nor permanent retention. File history alone does not establish legal compliance.

### Keep durable record versions

A Base admin can enable **Durable history** in **Table settings → History and protection**. This permanent opt-in captures existing records, then appends every create, update, trash, restore, Relation and File state.

The baseline cannot reconstruct earlier changes. Large tables use resumable batches; ordinary writes remain available and are captured atomically throughout.

Readers of a current Record can open **Versions** in its detail panel. A version shows the field meanings that applied then and can download the exact files retained by that version. Durable history increases storage use, has no disable action, and is not by itself a claim of legal or regulatory compliance. It is not exposed through normal Record lists or Custom Apps.

### Finalize records

After Durable History has finished its baseline, a Base admin can enable **Record finalization** in the same **History and protection** section. Existing and new records remain Draft until someone explicitly finalizes one. The setting belongs to one stored Table and offers two modes:

- **Direct:** someone with Write access can finalize the Record themselves.
- **Four-eyes:** someone with Write access requests Finalization for the exact current Record version. A different person must still have Write access and be a current member of the configured approver group to approve and finalize it.

The approver group grants no access. Mode and group activate atomically, without an interim Direct mode. Policy changes invalidate open requests. Changed values, Relations, Files, trash state, or live field definitions also require a new request. This includes field names: the reviewer approves the whole record's meaning, not only its totals. Requests, decisions, and finalization remain in audit history.

Each request has a short public ID. CLI approval and rejection require that exact ID, so a confirmation can never apply to a newer replacement request.

Finalization checks required fields, assigns **On finalization** IDs, freezes typed formula, lookup, rollup and list results, then locks the Record atomically. Exact decimals remain usable for arithmetic. Fields, Relations, Files, trash state and final numbers cannot change. Retries return the same Record without allocating another number.

Only captured calculations are historical values. Fields added later, and older finalizations without captures, have no saved result. Grids does not reconstruct them using current formulas. Do not interpret missing results as zero or use incomplete totals for financial exports.

Before the first record is finalized, an admin can disable the feature after changing all finalization-assigned ID fields back to **On record creation**. After the first final record, the table setting is permanent. Grids does not add invoice, cancellation, correction, or compliance semantics; model those with ordinary fields, Relations, and Workflows.

## Require change context {icon="point"}

In **Table settings → Data integrity**, an admin can require answers before sensitive field updates, moving records to trash, or restoring them. Questions can apply to every update or only when selected fields change.

The submitted answers are stored with the record history. Grids copies the question and option labels into the event, so old history remains understandable after the policy changes.

## Choose where record changes can start {icon="route"}

A Base admin can open **Table settings → Data integrity → Record changes** to choose which parts of Grids may change a stored table. **All** is the default and keeps the normal behavior of existing tables.

When **All** is off, choose one or more sources:

- **Direct editing and record API** covers editing in the Base or a Grids App, Record Editor, API, CLI, and imports.
- **Forms** covers active Forms, including Forms published in a Grids App.
- **Workflows and actions** covers enabled Workflows, run options, and published Grids App actions.

The policy applies to creating, editing, trashing, and restoring records, as well as changing Relations and Files. Before an admin removes Forms or Workflows and actions, Grids shows the active entry points that will stop changing the table. For a table used by very many Workflows, the preview says clearly when more may be affected than it can list.

Choosing no source freezes record changes until an admin allows one again. Existing records remain readable. The policy does not replace permissions, field rules, audit requirements, Durable History, or Finalization, and does not by itself provide a legal or regulatory guarantee.

:::note Model before display
Field type controls stored meaning. Views and column settings control how that value is presented in a particular context.
:::

:::note Bounded HTML exports
Default CSV and JSON exports omit HTML template fields. Select one explicitly and set a query limit of at most 1,000 records when the rendered HTML belongs in an export.

One read or export renders at most 2,000 HTML cells and 32 MB of combined HTML output. Cells beyond that shared budget show a render error instead of exhausting the server; request fewer records or HTML fields.
:::
