# Read and export documents

Read [cloud contract](cloud.md) first. Readers load on first use and parse locally
inside the isolated worker. Files are not uploaded by reading them.

```js
const workbook = await cloud.sheet.read(file, {numbers:"string"});
const names = workbook.sheetNames;
const firstRows = workbook.rows();
const otherRows = workbook.rows(names[1]);
```

The format is detected from XLSX/ODS bytes. Rows include the header row and keep
empty/duplicate headings. Formulas use cached values. Dates remain cell values;
CSV parsing converts numbers only and leaves dates as text. XLS/XLSB and formula
execution are unavailable. Read inputs sequentially to bound memory. The parsing
budget is 64 MiB per document and 128 MiB expanded workbook XML.

`await cloud.sheet.toOds([{name:"Results",rows:[["Name","Amount"],["Alice",12.5]]}])`
returns a Blob. Download it with `await cloud.download("results.ods", blob)`.

```js
const document = await cloud.pdf.read(file);
try {
  const page = await document.page(1);
  console.log(page.text, page.items);
} finally { await document.close(); }
```

PDF pages start at 1 and include text positions, dimensions, and page size.
There is no OCR. Use [PDF generation](pdf.md) for HTML rendering and attachments.
