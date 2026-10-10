---
id: grids-tables-fields
title: Tables & fields
icon: ti ti-table
description: Choose field types and control the lifecycle of saved records.
order: 110
---
A table stores one kind of record. Choose field types for their meaning, not only for their appearance.

The [field configuration reference](/app/grids/help/grids-field-configuration) lists all configuration keys, defaults, ID strategies, and object-list columns.

In **Base settings → Tables**, people with **Manage** access search by name or public ID. They compare the counts of fields, indexes, and unique fields, and the history, finalization, and write paths. Open a table for its records and settings. This overview does not count records.

## Store entered values {icon="table"}

| Field type | Use it for | Important behavior |
| --- | --- | --- |
| Text | Names, codes, email addresses, and short labels | Single-line text; a good default record label |
| Long text | Notes and descriptions | Can display Markdown when configured |
| Number | Quantities, prices, measurements, and exact decimal arithmetic | Can show a unit and decimal precision |
| Percent | Percentages | Uses 0–100 by default; a field can use a 0–1 fraction scale instead |
| Boolean | Yes/no facts | Stores true, false, or empty when optional |
| Date | A day or an exact date-time | A date-time value is a moment; a current-time default uses the time when a new record is saved |
| Duration | Elapsed time | Stored as seconds; accepts seconds, `MM:SS`, or `HH:MM:SS` |
| Select | A value from a controlled list | Options can have labels, colors, and descriptions; a select can allow several values |
| People and groups | One or several responsible people or groups | Stores typed Cloud user and group references; the picker shows only identities that the current account can discover |
| JSON | Structured data that needs no Grids fields of its own | Use sparingly; single properties are harder to filter and explain |
| Object list | Typed rows that belong to this record, such as invoice items | Shared validation, calculated columns, and atomic finalization |
| File | Attachments and images | The field controls accepted file types and file count; Grids enforces the configured upload-size limit |

Use **Required** when an empty value makes a record invalid. A **Default** fills a value only when a new record leaves that field out. Use **Unique values** for identifiers that must not repeat, such as an asset code or an invoice number.

Date-time display, date-based filters, formulas, exports, and document folders use the browser's timezone when it is available. Otherwise, they use the Cloud timezone. Date-only values stay calendar dates. Scheduled workflows use the IANA timezone in their YAML, and UTC when it is missing.

## Connect or calculate values {icon="table"}

- **Relation** links one record to one or several records in another table. Cells, cards, pickers, and filters show the record label of the target table.
- **Lookup** shows one field from a related record without copying it.
- **Rollup** summarizes values that a relation reaches.
- **Formula** calculates from the fields of the current draft. Finalization freezes the result.
- **HTML template** renders Liquid and optional CSS into one HTML string per record. It can use ordinary fields and the results of lookups, rollups, and formulas. Values are escaped by default. Preview the result before you use `raw`.
- **ID** creates a stable generated identifier. Sequence and date-sequence IDs use a durable number series. Grids assigns the number on creation by default, or on finalization when configured. Values increase atomically and are never reused. Rollbacks and technical failures can leave gaps. Changing the prefix or format affects only future records.
- **Created at**, **Created by**, **Updated at**, and **Updated by** are fields that the system fills. They describe record activity. People cannot enter them as ordinary business values.

Choose a relation when the target has its own details or lifecycle. A customer name typed into every invoice is only text. A Customer relation keeps the invoice connected when the details of the customer change.

The live record detail shows up to five **Referenced by** results next to its outgoing relations. Grids groups the results by source table and relation field. **Load more** fetches the next bounded page. The list shows only records that you can currently read. It never adds incoming links to the field data of the record.

In the CLI, use `cld grids records referenced-by <table-id> <record-id> --limit 5 --json`. Record comments are available through `records comments list|create|update|delete`. Use `--body-file` for Markdown and `--yes` to delete. Both lists accept `--cursor` and return `nextCursor`. These commands use public IDs. They keep the same access rules for the Base, authors, and moderation as the record detail.

People and groups values give no access. Full accounts can use the directory. Guests can select only themselves and their direct or nested groups, not other users or group members. Saving checks the visibility again, also for API submissions.

HTML template fields are read-only output per record. They are not immutable documents or PDFs. Tables show the escaped source. The record detail offers a sandboxed **Preview** and never injects HTML into the record page.

Templates use public field IDs, for example `{{ record.data.aB12xZ }}`, and autocomplete shows the names. Other HTML template fields are unavailable inside a template, which prevents recursion. These fields require stored tables. They do not support filters, sorting, grouping, aggregates, formulas, or relation lookups.

## Use formulas in a table {icon="table"}

The shared [formula reference](/app/grids/help/grids-formulas) describes syntax, examples, and errors. A table formula belongs to each record. A computed query column belongs only to its query.

## Store rows inside a record {icon="table"}

Choose **Object list** for items that have no access or lifecycle of their own. Otherwise, use a relation. Expand **Rules and calculation** for constraints or formulas that use sibling columns. Select columns and regex constraints apply only to input. A row cannot contain nested objects, relations, or lists.

Edit rows on pages of 25 rows without losing changes or valid previews. Saving validates the list and replaces it with version protection. The default is 0–100 rows. The limits are 1,000 rows, 200 columns, and 256 KiB. Removed columns are hidden in drafts, and stored history is not rewritten. You cannot remove a column that contains finalized values.

Use `LIST_SUM(Items, 'Amount')` for a total. `LIST_AVG`, `LIST_MIN`, and `LIST_MAX` use the same arguments. `LIST_COUNT(Items)` counts rows. An empty list sums and counts to zero. Other reductions on an empty list, and every reduction on a missing list, return null. Finalization freezes rows and calculated values together and keeps exact amounts and types.

## Search, filter, and index {icon="search"}

Broad search includes text, long text, IDs, numbers, percentages, durations, dates, booleans, select labels, and readable relation labels. Use filters for exact conditions and for rules on calculated values, lookups, rollups, files, or empty values.

An index helps fields that people often use for filtering, sorting, search, joins, or unique checks. Every index also adds work to writes. Add an index for an observed access pattern, not for every field.

## Keep record identity and history {icon="table"}

Choose one short, readable **record label** for every table. It is the title in relation pickers and detail panels. A long description is usually a poor label, even when it is unique.

If another person or tab changes a record before your edit is saved, Grids rejects your older edit and does not overwrite the newer data. Reload the record, review the newer values, and apply your change again.

Moving a record to the trash is reversible. Restoring it creates a new history event. It does not erase the deletion event.

### Attach files

To attach files, choose **Upload** or drop files from your computer onto the field of the open record. Grids names the files that do not fit the accepted types or the file count of the field and leaves them out. **Replace file** swaps an attachment atomically. **Remove from record** detaches it and logs the actor, the time, the field, and the immutable file metadata.

Protected revisions or artifacts keep the bytes of a detached file. Grids can clean up unprotected files. Detaching promises neither physical erasure nor permanent retention. File history alone does not establish legal compliance.

### Keep durable record versions

You need **Manage** access to the Base.

:::warning You cannot turn durable history off
Durable history is permanent. It keeps every record version and uses more storage over time.
:::

:::steps
1. Open **Table settings → History and protection**.
2. Choose **Enable durable history**.
3. In the confirmation, choose **Enable durable history** again.
:::

Grids first captures the existing records as a baseline. Then it appends every create, update, trash, restore, relation, and file state. The baseline cannot reconstruct earlier changes. Large tables use resumable batches. Ordinary writes stay available and are captured atomically throughout.

People who can read a current record can open **Record versions** in its detail panel. A version shows the meaning of the fields at that time. You can download the exact files that the version keeps. Durable history is not by itself a claim of legal or regulatory compliance. Normal record lists and Grids Apps do not expose it.

### Finalize records

After durable history has finished its baseline, a person with **Manage** access to the Base can enable **Record finalization** in the same **History and protection** section. Existing and new records stay drafts until someone finalizes one explicitly. The setting belongs to one stored table and offers two modes:

- **Direct:** A person with **Edit** access can finalize the record themselves.
- **Four-eyes:** A person with **Edit** access requests finalization for the exact current record version. A different person approves and finalizes it. That person must still have **Edit** access and be a current member of the configured approver group.

The approver group gives no access. Mode and group activate atomically, without an interim Direct mode. A policy change invalidates open requests. Changed values, relations, files, trash state, or live field definitions also require a new request. This includes field names: the reviewer approves the meaning of the whole record, not only its totals. Requests, decisions, and finalization stay in the audit history.

Each request has a short public ID. Approval and rejection in the CLI require that exact ID, so a confirmation can never apply to a newer replacement request.

Finalization checks required fields and assigns IDs that are set to **On finalization**. It freezes typed formula, lookup, rollup, and list results. Then it locks the record atomically. Exact decimals stay usable for arithmetic. Fields, relations, files, trash state, and final numbers cannot change. A retry returns the same record and allocates no other number.

Only captured calculations are historical values. A field added after finalization has no saved result, and Grids does not reconstruct it from current formulas. Do not read a missing result as zero. Do not use incomplete totals for financial exports.

:::warning Finalization becomes permanent with the first final record
Before the first record is finalized, a person with **Manage** access can disable the feature. First, they must change all ID fields that are assigned on finalization back to **On record creation**. After the first final record, the table setting is permanent.
:::

Grids does not add invoice, cancellation, correction, or compliance semantics. Model them with ordinary fields, relations, and workflows.

## Require change context {icon="point"}

In **Table settings → Data integrity**, a person with **Manage** access can require answers before sensitive field updates, before moving records to the trash, or before restoring them. Questions can apply to every update or only when selected fields change.

Grids stores the submitted answers with the record history. It copies the question and option labels into the event, so old history stays understandable after the policy changes.

## Choose where record changes can start {icon="route"}

A person with **Manage** access to the Base can open **Table settings → Data integrity → Record changes**. There they choose which parts of Grids can change a stored table. **All** is the default and keeps the normal behavior of existing tables.

When **All** is off, choose one or more sources:

- **Direct editing and record API** covers editing in the Base or a Grids App, the Record Editor, the API, the CLI, and imports.
- **Forms** covers active forms, including forms published in a Grids App.
- **Workflows and actions** covers enabled workflows, run options, and published Grids App actions.

The policy applies to creating, editing, trashing, and restoring records, and to changing relations and files. Before someone removes **Forms** or **Workflows and actions**, Grids shows the active entry points that will stop changing the table. For a table that very many workflows use, the preview says clearly when more can be affected than it can list.

Choosing no source freezes record changes until a person with **Manage** access allows a source again. Existing records stay readable. The policy does not replace access, field rules, audit requirements, durable history, or finalization. It does not by itself provide a legal or regulatory guarantee.

:::note Model before display
The field type controls the stored meaning. Views and column settings control how a value appears in a particular context.
:::

:::note Bounded HTML exports
Default CSV and JSON exports leave out HTML template fields. When the rendered HTML belongs in an export, select the field explicitly and set a query limit of at most 1,000 records.

One read or export renders at most 2,000 HTML cells. They share a budget of 32 MiB of combined HTML output and 2 seconds of template rendering. Cells beyond that budget show a render error instead of exhausting the server. Request fewer records or HTML fields.
:::
