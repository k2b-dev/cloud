# Accounting reference workflows

These are application examples, not new platform APIs or verified bank/invoice
parsers. `reconcile.ts` accepts normalized records with file/page evidence. It
covers multiple invoices per payment, credits, exact cent sums, conflicting and
identical duplicates, reused/ambiguous references, amount-only suggestions, and
CSV rows that count a collective payment only once.

Application pipeline:

1. Select a local folder and start `work.run`.
2. Open one PDF with `pdf.open`, read its pages, and close it in `finally`.
3. Route extracted page items to a format-specific parser. Unknown formats and
   textless pages become understandable file errors, not empty success.
4. Normalize amounts to signed integer cents: invoice costs and outgoing bank
   payments positive; credits negative. Keep date, currency, references, path,
   page, and extraction reason. Never confirm a mapping from amount alone.
5. Call `reconcile`, present confirmed/review/duplicate/missing cases, and export
   `exportRows(result).confirmed` through `sheet.toCsv` as `zuordnungen.csv` and
   `.open` as `offene-faelle.csv`. Defaults include semicolon, BOM, and CRLF;
   monetary columns already use decimal commas.

The checked-in PDF is deliberately synthetic. It proves text/page extraction,
not Sparkasse, DHL, or FedEx format support. Anonymized representative originals,
including invoices, credit notes, collective payments, and multi-page statements,
are required before those parsers can be accepted. No OCR or DATEV export.

## Local XLSX into remote SQLite

During app setup, connect its rsql database and create `ledger_rows` with:

```js
[
  {name:"import_key",type:"text",not_null:true,unique:true},
  {name:"payload",type:"text",not_null:true}
]
```

Normal users import rows without schema mutations. For each local workbook,
open it once with `sheet.openExcel(file, {numbers:"string"})`, validate its
headers, and process one sheet at a time. Build `ImportRow` records with
`import_key = JSON.stringify([files.path(file), sheetName, originalRowNumber])`
and `payload = JSON.stringify(originalRow)`. Call `importRows(db, rows,
job.checkpoint)` and then close the workbook. Files stay local; only extracted
records reach the remote resource database. A resource fork starts empty.

The helper uses atomic batches of 200 rows and a unique import key. Repeating
an interrupted import skips identical committed rows. Changed source rows stop
with a conflict instead of silently replacing data. A concurrent import can
fail a batch on the unique constraint; inspect and retry deliberately. There is
no whole-folder transaction or rollback of completed batches on cancellation.
For business joins, extract validated fields into typed columns in the actual
application rather than forcing all workflows into this example's raw payload.

Unit tests cover 2,500 rows with a simulated failure between batches, idempotent
retry, changed input, reconciliation ambiguity, and export counting. The browser
runtime tests separately cover real XLSX parsing, 3,000 local file references,
worker isolation, long work, and cancellation. Those checks do not substitute
for a measured import into the operator's rsql installation.
