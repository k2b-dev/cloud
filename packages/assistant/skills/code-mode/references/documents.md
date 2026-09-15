# Local PDF and Excel documents

Use this path when original documents must stay on the device. User apps select
files with their picker; parsing runs in the isolated worker, without upload or
network access. Do not send private local documents to `read_file` as a workaround.
Chat attachments have already been uploaded; scripts may explicitly select those.

## Learn the format before building around it

Inspect representative supplied files with a one-off script: sheet names and
headers for Excel, or text/positions from relevant PDF pages. Keep output small.
Test extraction and validation before building the surrounding app. If examples
are missing, request an anonymized sample only when upload fits the user's
requirements; offer a small saved script started by the user in Studio when
originals must stay local. Its picker and console can suffice without a custom UI.
Follow [Investigation patterns](investigation.md) for the general workflow.

## PDF

```js
const document = await pdf.open(file);
try {
  for (let number = 1; number <= document.pageCount; number++) {
    const page = await document.readPage(number);
    // page: {page, width, height, text, items}
    // item: {text, transform, width, height, direction, endOfLine}
  }
} finally {
  await document.close();
}
```

PDF.js is bundled; never import a package or fetch a CDN. Pages start at 1.
`transform` contains the six PDF text transformation values; retain original
items when layout matters. `text` is a convenient concatenation, not a table
parser. Keep `files.path(file)`, page number, and matching evidence alongside
every extracted record. A page without text needs review; no OCR is available.
Encrypted, unsupported, and corrupt files can throw. External font/CMap assets
are not fetched; verify extraction for documents requiring unusual fonts. Report the filename and
error, continue with other files, and never silently classify failures as empty.

Use the bundled `einvoice` and `camt` APIs for their supported XML formats; see
[Finance](finance.md). Other format-specific mappings belong in app source modules. Verify
against representative documents before claiming Sparkasse, DHL, or FedEx
support. Similar-looking PDFs can encode very different text layouts.

## Excel (XLSX only, reading only)

```js
const workbook = await sheet.openExcel(file, { numbers: "string" });
try {
  for (const name of workbook.sheetNames) {
    const rows = workbook.readSheet(name);
    // Arrays of cells, including the original header row.
  }
} finally {
  workbook.close();
}
```

The workbook is parsed once. Cells retain strings, booleans, dates, numbers,
and empty values. Default `numbers: "number"` uses JavaScript numbers; use
`"string"` when preserving decimal precision before converting amounts to cents.
Empty and duplicate headers remain visible in the arrays. Validate headers
before converting rows to objects; do not overwrite duplicate columns silently.
Date recognition follows stored Excel number formats; validate ambiguous dates.

Formulas are never executed. Only cached values are read; missing/error caches
may appear empty. Macros and external workbook links are not executed or fetched.
Legacy XLS/XLSB and Excel writing are not supported. Export with `sheet.toCsv`.

## Large folders

`files.openFolder()` returns file references, including thousands of files.
Use `files.path(file)` for the relative path, not the basename. Call `.text()`,
`.arrayBuffer()`, `pdf.open`, or `sheet.openExcel` only as needed. Process one
workbook/PDF at a time and close it in `finally`. Never use `Promise.all` over a
whole accounting folder or retain every parsed workbook.

A document parser accepts at most 64 MiB per input document. XLSX expanded ZIP
entries are checked against 128 MiB before parsing. These working-set budgets
apply to each document, not the selected folder. This is not streaming XML/PDF
parsing or a guarantee against all browser memory pressure. Split oversized
single documents and show actionable per-file errors. The host can terminate a
stuck worker; browser suspension or closing the host interrupts work.

Use [Background work](work.md) for progress, cancellation, and long imports.
Use [Database](database.md) when extracted Excel rows should be stored in the
resource's remote rsql database. Original files need not be uploaded. Import
with structured batched writes; use SELECT for joins and `code_sql` for direct
inspection. Do not introduce another local SQLite engine.
