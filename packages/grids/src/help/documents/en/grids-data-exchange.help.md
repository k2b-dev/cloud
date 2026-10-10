---
id: grids-data-exchange
title: Import, export, and external identities
icon: ti ti-arrows-exchange
description: Bring records into Grids, retry integrations safely, and tell exports from backups.
order: 112
---
Choose the operation by its purpose:

:::compare
- **Import:** A one-off import creates new records.
- **External-identity upsert:** Reconciles one known item from a source system.
- **Query export:** Downloads selected data.
- **Evidence export:** Preserves verifiable history.
:::

## Import new records {icon="file-import"}

Discover the target table with `cld grids records shape <base> <table> --json`. JSON values use public field IDs and the actual type of each field:

- Select values are arrays of option IDs.
- Numbers are exact decimal strings.
- Relations use public record IDs.

You cannot write system fields and calculated fields.

`cld grids records import <base> <table> --body-file records.json` accepts an array or `{"items":[...]}` with 1–500 plain record-value objects. The import creates all records in one transaction. A validation failure rolls back the whole batch.

:::warning An import does not update by name
An import only creates records. If you retry after an uncertain result, the import can create duplicates.
:::

For example, if `Name01` is the real ID of a text field:

```json
{"items":[{"Name01":"First item"},{"Name01":"Second item"}]}
```

Required fields, uniqueness, defaults, the mutation policy, and access to the Base still apply. Upload attachments separately with the file operations. Combined tables are read-only and cannot receive imports.

## Connect an external system {icon="plug"}

Use `records upsert-external` when a source supplies stable identities:

```sh
cld grids records upsert-external <base> <table> \
  --provider crm --provider-account main --resource-kind contact \
  --external-id contact-42 --idempotency-key contact-42-revision-1 \
  --body-file contact.json
```

Together, `provider`, `providerAccount`, `resourceKind`, and `externalId` identify the source item. `--body-file` contains normal writable field values. The idempotency key identifies this one logical request. Reuse it unchanged after an uncertain result. Do not reuse it for a new update.

An existing binding requires `--if-version <current-version>`. After a version conflict, read the record again and merge on purpose. Do not force an overwrite. Identity matching does not compare display names and does not reopen deleted or finalized records.

`records upsert-external-batch` accepts `{"items":[...]}` with up to 100 entries. Each entry has `externalRef`, `values`, `idempotencyKey`, an optional `ifVersion`, and an optional `audit`. Items run in order and commit independently.

:::warning A batch is not all-or-nothing
Unlike a normal import, this batch can commit some items and fail others. Inspect each outcome and the `complete` flag of the response.
:::

These APIs do not schedule a sync. They give no access to another Cloud app. A connector owns access to the source and change detection. A file hash alone is not a stable identity for a bank booking across overlapping reports.

## Export the intended data {icon="file-export"}

`records export <base> <table> --format csv|json --out result.csv` exports through the query path, which checks access. `--body-file` supplies the full query and export configuration. `--limit` caps the result at 10,000 rows or fewer. A query with a deliberate limit is not a complete table export. The CLI command help describes the delimiter, Markdown handling, and row bounds.

For repeatable, immutable files from several records, use [workflow query captures and document outputs](/app/grids/help/grids-workflows). PDF, free CSV/JSON/XML, DATEV CSV, and SEPA XML share the document lifecycle. Creating a SEPA file does not transfer money. Creating a DATEV CSV file does not import it into accounting software.

:::warning A download is not a backup
A CSV or JSON download does not recreate access, workflow state, templates, attachments, or immutable history. Use [Evidence exports](/app/grids/help/grids-evidence-exports) for verifiable retained evidence. Use the operator's backup procedure for disaster recovery.
:::
