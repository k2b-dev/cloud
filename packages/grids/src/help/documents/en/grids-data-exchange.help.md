---
id: grids-data-exchange
title: Import, export, and external identities
icon: ti ti-arrows-exchange
description: Bring records into Grids, retry integrations safely, and distinguish exports from backups.
order: 112
---
Choose the operation by intent: a one-off import creates new Records; an external-identity upsert reconciles one known source item; a query export downloads selected data; an Evidence export preserves verifiable history.

## Import new Records

Discover the destination with `cld grids records shape <base> <table> --json`. JSON values use public field IDs and each field's actual type; select values are option-ID arrays, numbers use exact decimal strings, relations use public Record IDs. System and calculated fields are not writable.

`cld grids records import <base> <table> --body-file records.json` accepts an array or `{"items":[...]}`, with 1–500 plain Record-value objects. The batch creates Records in one transaction. A validation failure rolls back the whole batch. It is not an update-by-name operation, and retrying after an uncertain successful import can create duplicates.

For example, if `Name01` is the real text field ID:

```json
{"items":[{"Name01":"First item"},{"Name01":"Second item"}]}
```

Required fields, uniqueness, defaults, mutation policy, and Base permissions still apply. Upload attachments separately with File operations. Combined tables are read-only and cannot receive imports.

## Integrate an external system

Use `records upsert-external` when a source supplies stable identities:

```sh
cld grids records upsert-external <base> <table> \
  --provider crm --provider-account main --resource-kind contact \
  --external-id contact-42 --idempotency-key contact-42-revision-1 \
  --body-file contact.json
```

The tuple `provider`, `providerAccount`, `resourceKind`, `externalId` identifies the source item. `--body-file` contains normal writable field values. The idempotency key identifies this one logical request: reuse it unchanged after an uncertain result, not for a new update.

An existing binding requires `--if-version <current-version>`. A version conflict needs a fresh read and deliberate merge, not a forced overwrite. Identity matching does not match by display names or reopen deleted/finalized Records.

`records upsert-external-batch` accepts `{"items":[...]}` with up to 100 entries, each with `externalRef`, `values`, `idempotencyKey`, optional `ifVersion`, and optional `audit`. Items run in order and commit independently. Inspect each outcome and the response's `complete` flag; unlike normal import, this batch is not all-or-nothing.

These APIs do not schedule a sync or authorize access to another Cloud application. A connector owns source access and change detection. A file hash alone is not a stable bank-booking identity across overlapping reports.

## Export the intended data

`records export <base> <table> --format csv|json --out result.csv` exports through the permission-aware query path. `--body-file` supplies the full query/export configuration; `--limit` caps the result to at most 10,000 rows. A deliberate query limit is not a complete table export. Use the CLI's command help for delimiter, Markdown handling and row bounds.

For repeatable, immutable files from several Records, use [workflow query captures and document outputs](/app/grids/help/grids-workflows). PDF, free CSV/JSON/XML, DATEV CSV and SEPA XML share the Document lifecycle. Creating a SEPA file does not transfer money; creating DATEV CSV does not import it into accounting software.


A CSV/JSON download is not a complete backup: it does not recreate permissions, workflow state, templates, attachments and immutable history. Use [Evidence exports](/app/grids/help/grids-evidence-exports) for verifiable retained evidence and the operator's backup procedure for disaster recovery.
