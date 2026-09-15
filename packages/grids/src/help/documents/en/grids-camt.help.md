---
id: grids-camt
title: Read bank reports (CAMT)
icon: ti ti-file-analytics
description: Capture a bank report, inspect its accounts, and retain the original without posting payments.
order: 153
---
Use the workflow action `parseDocument` to read **camt.052.001.08** XML from a Record's File field. Grids captures the file and its parsed account reports together. It does not create payments, mark invoices as paid, match bank entries, or merge report pages.

## Start with a File field

Create a table such as **Bank imports** with a File field **Bank file**. Set `maxFiles: 1` and accept `.xml` if appropriate. Upload the bank file through the normal Record or Form upload. The action rejects zero or multiple attachments rather than guessing.

Publish a workflow with the table and field names from your Base:

```yaml
inputs:
  selected:
    type: record
    table: Bank imports
    required: true
steps:
  - parseDocument:
      record: inputs.selected
      field: Bank file
      format: camt.052.001.08
      saveAs: bank
  - generateDocument:
      data: bank
      output:
        kind: json
```

`record` is a Record reference, not an interpolated object or an arbitrary file ID. `field` must name a File field in that Record's declared table. These dependencies bind when the workflow is published. The workflow's normal Base permissions apply.

A dry run checks the Record reference but does not read, validate, capture, or export the file. Execute with a representative file before using the workflow for real work.

## What the result means

`saveAs: bank` receives a small immutable reference. The API presents it in the step result as:

```json
{"kind":"fileSnapshot","stepKey":"steps.0","sha256":"<capture hash>","rowCount":2,"capturedAt":"2026-09-15T12:00:00.000Z"}
```

The public result identifies the capture by its owning run's Short ID and `stepKey`. Capture UUIDs stay internal. `sha256` hashes the whole capture; the original file has its own hash. `rowCount` counts account reports, **not bookings or transactions**.

Pass `data: bank` directly to `generateDocument`. As with query captures, `data.rows` in a template contains one row per result; each row has a `report` object. Generic JSON export retains that hierarchy. It is not a flat CSV ledger.

The captured report keeps account identifiers, report dates, balances, entries, transaction details and references supplied by the bank. Important distinctions remain:

- Amounts are decimal strings with their currency; do not convert them to binary floating-point numbers.
- `CRDT` and `DBIT` remain separate from positive amounts. A debit is not silently rewritten as a negative number.
- Entry status, such as `BOOK` or `PDNG`, and reversal flags are retained. Parsing does not declare settlement.
- An entry may have multiple transaction details. Their amounts may be absent; Grids does not distribute an entry total among them.
- Message and account-report pagination are separate. `lastPage: false` means more pages exist. Missing pagination means completeness is unknown.
- Capture `complete: true` only means the supplied file was captured without truncation; it never means the bank sent every page.

## Inspect or download

Open the workflow run, expand the completed `parseDocument` step, and choose **View bank report**. The overview shows an account report at a time, entry counts, statuses, and pagination. Expand **Report details** for the structured data. **Original file** downloads the exact uploaded XML bytes, even if that attachment was later detached.

The CLI provides the same read-only access:

```sh
cld grids workflow-runs steps <run>
cld grids workflow-runs file <run> <step-key> --sha256 <capture-hash>
cld grids workflow-runs file <run> <step-key> --sha256 <capture-hash> --json
cld grids workflow-runs download-file <run> <step-key> --sha256 <capture-hash> --out bank.xml
```

The API is `GET /api/grids/workflows/runs/:runId/files/:stepKey?sha256=...`. URL-encode `stepKey` from the step result. Add `&download=original` for XML. Both require access to the run's Base; a capture cannot be opened through another run or Base. The JSON response exposes report details but not the original base64 payload.

## Supported scope and limits

Only UTF-8 XML (optionally with a UTF-8 BOM) and `camt.052.001.08` are supported. Other CAMT namespaces, including 053 and 054, are rejected. Do not rename a namespace to force a bank file through the reader.

The parser rejects malformed XML and DTDs. Parsing checks the supported structure; it is not a bank reconciliation or a claim of full XSD/business-rule certification.

The existing **5 MiB cumulative workflow capture budget** covers both the base64 original and parsed JSON, plus other captures in that run. Therefore a file smaller than 5 MiB can still exceed the budget. Nothing is silently truncated. Use smaller bank reports when necessary.

A bank file capture does not automatically associate the generated export with every Record whose identifier happens to appear inside XML. [Document source membership](/app/grids/help/grids-documents-pdfs) comes from explicit captured Record data, not guessed bank references.

Related: [Workflows](/app/grids/help/grids-workflows), [Files and generated documents](/app/grids/help/grids-documents-pdfs), [Permissions](/app/grids/help/grids-permissions).
