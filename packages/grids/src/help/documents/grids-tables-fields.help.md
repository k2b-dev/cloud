---
id: grids-tables-fields
title: Tables & fields
icon: ti ti-table
description: Choose field types and manage the lifecycle of saved records.
order: 110
---
A table stores one kind of record. Its fields define which facts every record can hold and how Grids treats those values in tables, forms, filters, formulas, documents, workflows, and exports.

Choose a field type for the meaning of the value, not merely for how it should look.

Base admins can open **Base settings → Tables** to find Tables by name or public ID and compare their structure and protection settings in one
place. The overview shows field, indexed-field, and unique-field counts together with Durable History, Finalization, and allowed write paths. It
does not calculate Record totals; open the Table for its Records, schema, or **History and protection** settings.

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
| File | Attachments and images | The field controls accepted file types and file count; Grids enforces the configured upload-size limit |

Use **Required** when an empty value would make a record invalid. A **Default** fills a value only when a new record omits that field. Use **Unique** for identifiers that must not repeat, such as an asset code or invoice number.

Date-time display, date-based filters, formulas, exports, and document folders use the browser's timezone when it is available, then fall back to the Cloud application timezone. Date-only values remain calendar dates. Scheduled workflows use the IANA timezone declared in their YAML and default to UTC when it is omitted.

## Fields that connect or calculate {icon="table"}

- **Relation** links one record to one or several records in another table. The target table's record label is shown in pickers and cells.
- **Principal** assigns one or several Cloud users or groups to a record. Use it for participants, owners, reviewers, or responsible teams instead of copying names or email addresses into business data.
- **Lookup** displays one field from a related record without copying it.
- **Rollup** summarizes values reached through a relation.
- **Formula** calculates a value from fields in the current record whenever the record is read.
- **HTML template** renders Liquid and optional CSS into one HTML string per record. It can use ordinary fields plus lookup, rollup, and formula results. Values are escaped by default; preview the result before using `raw`.
- **ID** creates a stable generated identifier. Sequence and date-sequence IDs use a durable number series that Grids assigns when the record is created. Values increase atomically and are never reused; rollbacks and technical failures can leave gaps. Changing the prefix or format affects only future records.
- **Created at, Created by, Updated at, and Updated by** are system-managed fields. They describe record activity and cannot be entered as ordinary business values.

Choose a relation when the target has its own details or lifecycle. A customer name typed into every invoice is only text; a Customer relation keeps the invoice connected when the customer's details change.

The live record detail shows up to five **Referenced by** results beside its outgoing Relations. Results are grouped by source table and Relation field; **Load more** fetches the next bounded page. The list follows current read permissions and never adds incoming links to the record's field data.

Principal values use the Cloud identity directory without becoming Cloud permissions. Full accounts can select from the directory. Guest accounts can select themselves and their direct or nested groups, but cannot discover other users or group members. The server applies the same visibility check again when saving, so a hidden UUID cannot be guessed through the API.

HTML template fields are read-only output columns, not Documents. Use them when each record needs an email body, article description, product snippet, or export value. Use Documents when the output needs an immutable snapshot, download, or PDF. Tables can show escaped source text; the record detail shows only a **Preview** action so long markup does not obscure the other fields. Previews open in a sandboxed frame, and Grids never inserts the value directly into the record page.

Templates read stable public field IDs such as `{{ record.data.aB12xZ }}`. The editor shows the matching field name in autocomplete. Other HTML template fields are intentionally unavailable, so templates cannot recurse. HTML template fields are available on stored tables only; they cannot be filtered, sorted, grouped, aggregated, used by formulas, or selected through a relation lookup.

## Formulas in a table {icon="table"}

Formula fields use the same expression language as computed query columns. Reference fields by name, quote names containing spaces with double quotes, and keep text literals in single quotes.

**Line total**

```text
"Unit price" * Quantity
```

**Readable fallback**

```text
IFEMPTY(Notes, 'No notes')
```

**Days until due**

```text
DATEDIFF(TODAY(), "Due date", 'days')
```

Open **Formulas** for the full function reference. Use `IFERROR` only when an error is an expected case, such as division by zero; otherwise let the error reveal a broken formula.

## Search, filters, and indexes {icon="search"}

Text, long text, ids, numbers, percentages, durations, dates, booleans, select labels, and readable relation labels participate in broad search. Use filters for exact conditions and for calculated, lookup, rollup, file, or empty-value rules.

An index helps fields used often for filtering, sorting, search, joins, or unique checks. Every index also adds write work, so add one for an observed access pattern rather than every field.

## Record identity and history {icon="table"}

Choose one short, readable **record label** for every table. It is the title shown in relation pickers and detail panels. A long description is usually a poor label even when it is unique.

If another user or tab changes a record before your edit is saved, Grids rejects the older edit instead of silently overwriting newer data. Reload the record, review the newer values, and apply the change again.

Moving a record to trash is reversible. Restoring it creates a new history event; it does not erase the deletion event.

Files have a separate lifecycle from their current field placement. **Replace** swaps the current attachment atomically. **Remove from record** detaches it and records the actor, time, field, and immutable file metadata in history. A protected revision or generated artifact can retain the exact bytes after detachment; an unprotected file can be cleaned up. Removing an attachment is therefore not a promise of physical erasure or permanent retention, and Grids does not claim that file history alone establishes legal compliance.

### Keep durable record versions {icon="history"}

A Base admin can open **Table settings → History and protection** and enable **Durable history** for a stored table. Enabling is permanent. It creates a baseline of the records that exist at that moment, then keeps every later create, update, trash, restore, Relation, and File state as an append-only version.

The baseline is the earliest state Grids can prove. It does not reconstruct changes from before activation. Larger tables protect their baseline in resumable batches; normal writes remain available and are captured atomically while that baseline is running.

Readers of a current Record can open **Versions** in its detail panel. A version shows the field meanings that applied then and can download the exact files retained by that version. Durable history increases storage use, has no disable action, and is not by itself a claim of legal or regulatory compliance. It is not exposed through normal Record lists or Custom Apps.

### Finalize records {icon="lock"}

After Durable History has finished its baseline, a Base admin can enable **Record finalization** in the same **History and protection** section. Existing and new records remain Draft until someone explicitly finalizes one. The setting belongs to one stored Table and offers two modes:

- **Direct:** someone with Write access can finalize the Record themselves.
- **Four-eyes:** someone with Write access requests Finalization for the exact current Record version. A different person must still have Write access and be a current member of the configured approver group to approve and finalize it.

Choosing an approver group does not grant access. The mode and group are stored atomically when Finalization is enabled, so a Table intended for Four-eyes review is never briefly available in Direct mode. Changing the mode or approver group invalidates open requests so that an old review cannot authorize work under a new policy. Changing values, Relations, attached Files, or moving the Record through trash invalidates its request; submit the current state again. Request, approval, rejection, and the final Record lock remain visible in audit history.

Each request has a short public ID. CLI approval and rejection require that exact ID, so a confirmation can never apply to a newer replacement request.

Finalization checks every required field, assigns any sequential ID configured for **On finalization**, stores the final version, and then permanently locks the record in one operation. Its fields, Relations, Files, trash state, and final number can no longer change. A retry returns the same finalized record and never allocates a second number.

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
