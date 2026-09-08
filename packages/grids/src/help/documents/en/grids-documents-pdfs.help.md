---
id: grids-documents-pdfs
title: Documents & PDFs
icon: ti ti-file-type-pdf
description: Create, generate, organize, and share PDFs from saved records.
order: 135
---
Document templates turn table records into repeatable PDFs. Use them for invoices, contracts, labels, certificates, delivery notes, quotes, packing lists, checklists, and record summaries.

Each template belongs to one table and defines one document family. A generated document belongs to one selected record, receives a stable number and filename, and keeps the exact source snapshot after the live records change. It appears in the record's Documents section, its template workspace, and the Base-wide **All documents** catalog.

Use a document template when output must be formatted for people, printed, shared by an expiring link, or redownloaded later. Use CSV or JSON export when you only need data for another system.

## One immutable Document model {icon="shield-check"}

Agents can use `document.templates` to find templates, `document.list` and `document.read` to inspect stored documents, and `document.create` to issue one document for a selected Record. Issuance requires write access, an idempotency key and individual approval. It cannot be undone or remembered as blanket approval. The returned download link requires your existing permissions; it does not create a public share link or send the document.

Every completed Document is immutable. It belongs to one template and one selected record, and the same Document appears in the record detail, the template workspace, and **All documents**. Retrying generation with the same idempotency key returns the same Document; reusing that key with different input fails.

If generation fails, **Retry generation** resends the original inputs. Once generation has saved its source data, retries use that data even if the record or template changes. The dialog locks the inputs and hides the live preview during retries. To correct inputs or use current data, choose **Start a new attempt** and preview again. Check **All documents** first: the previous attempt may already have created a Document, and a new attempt can create another one. Writers can still manage existing Document links when its template is disabled or no longer available.

A template selects one renderer. The HTML renderer turns Liquid HTML and CSS into a PDF. An installed E-Invoice renderer maps the selected record through Liquid JSON, then creates and validates the PDF and structured artifact together. The renderer changes the artifacts a Document contains, not the Document model or the way it is generated, listed, inspected, or downloaded.

Validation proves only the technical checks named by the selected renderer and version. It is not a general tax, accounting, signature, custody, or legal-compliance decision. Use `cld grids documents renderers --json` to inspect the renderers available on this installation.

The built-in `de.zugferd.en16931@1` renderer creates outgoing EUR invoices as a readable PDF/A-3b with an embedded `factur-x.xml`, and retains the XML as a separate artifact. It verifies the embedded XML after rendering, targets ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, validates the generated CII XML against the pinned XSD, and uses exact decimal strings with documented half-up rounding. Version 1 supports German seller and buyer addresses, standard VAT categories, and bank transfer. It does not cover corrections, replacements, incoming invoices, foreign currencies, tax exemptions, allowances, charges, prepayments, cash discounts, self-billing, or filings. The invoice issuer is responsible for the content and for checking whether this renderer fits the intended use. Grids does not certify tax or legal compliance.

## From record to PDF {icon="table"}

The template separates data selection from rendering. **GQL** loads the rows and columns the Document may use. The selected renderer then receives either Liquid HTML and CSS or one Liquid JSON object.

**Pipeline**

```text
selected record
  -> fill record values into the GQL source
  -> run the GQL query
  -> render the selected HTML or E-Invoice input
  -> create and validate the artifacts
  -> save the Document and source snapshot
```

Keep filtering, sorting, joins, grouping, and totals in GQL. Keep Liquid focused on wording and page layout.

For an E-Invoice template, choose its renderer and map the preview data in **Renderer input**. The editor expects one JSON object. Use the `json` filter for every inserted value, for example `"buyerReference": {{ record.id | json }}`, so quotes and other characters remain valid JSON. Previewing runs that renderer's validation and PDF generation before the template is enabled.

## Create your first template {icon="file-description"}

:::steps
1. **Open templates:** Open the table in edit mode and choose Templates. Templates belong to the table they generate documents for.
2. **Choose a starter:** Pick the structure closest to the output you need. Every starter remains fully editable.
3. **Select a preview record:** The same record anchors the rendered GQL, Data tree, and PDF preview.
4. **Inspect before editing:** Source shows the GQL after record values are inserted. Data shows the exact Liquid paths. Preview shows the PDF.
5. **Change one layer at a time:** Adjust GQL when data is wrong; adjust Body, Header, Footer, or Page CSS when layout is wrong.
6. **Preview representative data:** Test long text, missing values, many rows, and page breaks. The editor starts new templates disabled.
7. **Enable and test:** Base users with Write access can then select a record and generate a saved document.
:::

The selected preview record is only test context. Generating later prompts the user to select the actual record and can override the filename or add tags.

## Starters {icon="square-plus"}

Starters are editable templates, not fixed document types. Pick the closest structure, then change the GQL source and Liquid parts until the generated PDF matches the records in the table.

- `Invoice`
- `Loan agreement`
- `Label`
- `QR label`
- `Overview report`
- `Record detail`
- `Delivery note`
- `Quote`
- `Packing list`
- `Certificate`
- `Checklist`
- `Badge / name tag`

## Editable parts {icon="table"}

A template has one data part and up to four layout parts. The GQL source is rendered with Liquid first, so it can use the selected `record`, public `app`, and base `business` values before the query is parsed.

| Part       | Language      | Purpose                                                                                          | Common use                                                                |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| GQL source | Liquid + GQL  | Selects the rows and columns available to the document. Liquid is rendered before GQL is parsed. | Current record, joined rows, item lists, grouped summaries.               |
| Body       | Liquid + HTML | Main printable content for the HTML renderer.                                                     | Invoice body, contract clauses, label layout, record detail tables.       |
| Header     | Liquid + HTML | Optional header shown on each page.                                                              | Letterhead, sender identity, document class, contact block.               |
| Footer     | Liquid + HTML | Optional footer shown on each page.                                                              | Legal footer, bank data, and page placeholders such as `<span class="pageNumber"></span>` and `<span class="totalPages"></span>`. |
| Page CSS   | Liquid + CSS  | Optional CSS injected into the PDF body document.                                                | @page size/margins, table headers, page breaks, print typography.         |

## Understand the available data {icon="layout-grid"}

The Data tab is the source of truth for the current preview record. It shows the exact shape Liquid receives after the GQL source has run. Copy paths from this tree instead of guessing object shapes.

Think of the data in layers: `record` is the selected record, `rows` and `columns` are the GQL result, and `document` describes a saved Document. `template`, `document`, and `date` provide stable metadata for numbers and filenames. `app` contains public platform branding. `business` contains the Base's shared document details. Rows also expose GQL output labels, so readable aliases make templates easier to maintain.

:::reference
- **record:** The current record: public `record.id` and `record.tableId`, `record.version`, `record.data`, created and updated timestamps.
- **rows and columns:** The rows and columns returned by the GQL source. Use column.key for row access and column.label for human-readable headers.
- **template, document, date:** Stable metadata for patterns and document copy: `{{ template.name }}`, `{{ template.id }}`, `{{ document.id }}`, `{{ date.iso }}`, and `{{ date.yyyyMMdd }}`. Draft previews use draft document values until a Document exists.
- **app:** Public platform values for document branding: `{{ app.name }}`, `{{ app.contactEmail }}`, `{{ app.url }}`, `{{ app.logoDataUri }}`, and `{{ app.timezone }}`.
- **business:** Base-level document details such as `{{ business.legalName }}`, `{{ business.senderLine }}`, `{{ business.address }}`, `{{ business.paymentTerms }}`, `{{ business.iban }}`, and footer/contact fields. Edit them in Base settings → Documents.
- **images:** Image files attached to file fields on the selected record. Use `{{ primaryImage.url }}` for the first supported image or loop over `images`. Oversized and unsupported files are omitted.
- **document:** Document metadata such as `{{ document.number }}` and `{{ document.createdAt }}`. Use it in filenames and body/header/footer HTML after the number pattern has rendered. Draft previews may not have final values yet.
- **snapshot:** The captured record graph for a generated Document. It is null in live draft previews.
- **barcode_data_url:** A Grids Liquid filter for labels and badges. It returns an SVG data URL for QR codes and supported BWIP barcode symbols.
:::

## GQL source patterns {icon="code"}

Keep filtering, sorting, joins, grouping, and limits in GQL. Keep Liquid focused on presentation.

**Current record only**

```gql
from table Invoices
where record.id = '{{ record.id }}'
limit 1
```

**Current record with related item names**

```gql
from table Loans
left join table Items as item on Items = item.id
select "Loan number", Borrower, item.Name as item_name, item.Condition as item_condition
where record.id = '{{ record.id }}'
sort item.Name asc
```

**Batch or checklist**

```gql
from table Items
select Name, Status, Location
where Status = 'Ready'
sort Name asc
limit 100
```

## Numbers and filenames {icon="paperclip"}

A generated Document has a stable `document.number`. An HTML template owns a durable number series. Its number pattern is rendered first, and its filename pattern can then use `{{ document.number }}`. An E-Invoice renderer owns its numbering and artifact filenames.

The default HTML number pattern is `{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}`. A custom pattern may use the allocated `{{ series.value }}`. Allocations increase atomically and are never reused, but rollbacks and technical failures can leave gaps. Grids does not claim that a number pattern alone establishes legal compliance.

**Default number**

```text
{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}
```

**Default filename**

```text
{{ document.number }}.pdf
```

**Business-style number**

```text
INV-{{ date.yyyy }}-{{ document.id }}
```

**Sequential number**

```text
INV-{{ date.yyyy }}-{{ series.value }}
```

**Readable filename**

```text
invoice-{{ record.data.Name | default: document.number }}-{{ document.number }}.pdf
```

:::reference
- **Number pattern context:** May use `record`, `table`, `template`, `document`, `series`, `date`, `app`, and `business`. `series.id` is the public series ID and `series.value` is the allocated number. `document.id` is already available; `document.number` is the result being calculated and is not yet available.
- **Filename pattern context:** May use the full rendered data tree, including `{{ document.number }}`. The final filename is cleaned for filesystem-safe PDF downloads.
- **Validation:** Unknown top-level Liquid variables, invalid tags, unsupported filters, empty patterns, and oversized patterns fail when the template is saved.
:::

## Liquid reference {icon="book-2"}

Template parts use Liquid with Grids restrictions: strict variables, strict filters, escaped output, no layouts, no dynamic partials, and only the tags listed below. Unknown filters, invalid tags, and oversized output fail instead of creating a partial document.

:::reference
- **Output:** Use `{{ value }}` to print a value. Output is HTML-escaped by default. Use `| raw` only when a trusted template intentionally prints HTML.
- **Filters:** Pipe values through filters, for example `{{ row.Name | default: '-' }}`. Unknown filters fail.
- **Conditions:** Use `{% if row.Status == 'Open' %}`, `elsif`, `else`, and `endif`.
- **Loops:** Use `{% for row in rows %}` and `{% endfor %}`. Break and continue are allowed.
- **Temporary values:** Use `assign` for short values and `capture` for longer rendered fragments.
- **No external partials:** Include, render, layout, and external partial tags are not allowed. A template must be self-contained.
:::

Allowed tags

- `if`
- `elsif`
- `else`
- `endif`
- `unless`
- `endunless`
- `for`
- `break`
- `continue`
- `endfor`
- `case`
- `when`
- `endcase`
- `assign`
- `capture`
- `endcapture`
- `comment`
- `endcomment`
- `raw`
- `endraw`

## Barcodes and QR codes {icon="code"}

Use the `barcode_data_url` filter in an `<img>` tag. Barcode ids are lowercase symbols. The optional third argument controls human-readable text for barcode formats that support it.

**Code 128 with text**

```text
{% if rows.size > 0 and columns.size > 0 %}
  {% assign first = rows[0] %}
  {% assign codeColumn = columns[0] %}
  {% assign codeValue = first[codeColumn.key] | default: table.name %}
{% else %}
  {% assign codeValue = table.name %}
{% endif %}
<img src='{{ codeValue | barcode_data_url: "code128", true }}' alt="Asset barcode">
```

**QR code**

```html
<img src='{{ document.number | default: table.name | barcode_data_url: "qrcode" }}' alt="Document QR code">
```

| Type id           | Label              | Use                               |
| ----------------- | ------------------ | --------------------------------- |
| `code128`         | Code 128           | General-purpose linear barcode.   |
| `qrcode`          | QR Code            | Compact 2D code for phones.       |
| `datamatrix`      | Data Matrix        | Small 2D code for labels.         |
| `pdf417`          | PDF417             | Stacked 2D code for documents.    |
| `azteccode`       | Aztec Code         | Dense 2D code without quiet zone. |
| `ean13`           | EAN-13             | Retail product code, 13 digits.   |
| `ean8`            | EAN-8              | Short retail product code.        |
| `upca`            | UPC-A              | US retail product code.           |
| `upce`            | UPC-E              | Compressed UPC code.              |
| `itf14`           | ITF-14             | Carton and package code.          |
| `gs1datamatrix`   | GS1 Data Matrix    | GS1 2D code with application IDs. |
| `sscc18`          | SSCC-18            | Shipping container code.          |
| `isbn`            | ISBN               | Book identifier barcode.          |
| `issn`            | ISSN               | Serial publication barcode.       |
| `ismn`            | ISMN               | Printed music barcode.            |
| `code39`          | Code 39            | Simple alphanumeric barcode.      |
| `code93`          | Code 93            | Compact alphanumeric barcode.     |
| `interleaved2of5` | Interleaved 2 of 5 | Numeric warehouse barcode.        |
| `micropdf417`     | MicroPDF417        | Compact stacked 2D code.          |
| `microqrcode`     | Micro QR Code      | Tiny QR variant.                  |
| `maxicode`        | MaxiCode           | Parcel and logistics 2D code.     |
| `dotcode`         | DotCode            | Dot-based production code.        |

Additional BWIP symbol ids

- `auspost`
- `azteccodecompact`
- `aztecrune`
- `bc412`
- `channelcode`
- `codablockf`
- `code11`
- `code16k`
- `code2of5`
- `code32`
- `code39ext`
- `code49`
- `code93ext`
- `codeone`
- `coop2of5`
- `d3aqr`
- `daft`
- `databarexpanded`
- `databarexpandedcomposite`
- `databarexpandedstacked`
- `databarexpandedstackedcomposite`
- `databarlimited`
- `databarlimitedcomposite`
- `databaromni`
- `databaromnicomposite`
- `databarstacked`
- `databarstackedcomposite`
- `databarstackedomni`
- `databarstackedomnicomposite`
- `databartruncated`
- `databartruncatedcomposite`
- `datalogic2of5`
- `datamatrixrectangular`
- `datamatrixrectangularextension`
- `ean13composite`
- `ean14`
- `ean2`
- `ean5`
- `ean8composite`
- `flattermarken`
- `gs1datamatrixrectangular`
- `gs1dldatamatrix`
- `gs1dlqrcode`
- `gs1dotcode`
- `gs1northamericancoupon`
- `gs1qrcode`
- `hanxin`
- `hibcazteccode`
- `hibccodablockf`
- `hibccode128`
- `hibccode39`
- `hibcdatamatrix`
- `hibcdatamatrixrectangular`
- `hibcmicropdf417`
- `hibcpdf417`
- `hibcqrcode`
- `iata2of5`
- `identcode`
- `industrial2of5`
- `japanpost`
- `kix`
- `leitcode`
- `mailmark`
- `mands`
- `matrix2of5`
- `msi`
- `onecode`
- `pdf417compact`
- `pharmacode2`
- `pharmacode`
- `planet`
- `plessey`
- `posicode`
- `postnet`
- `pzn`
- `rectangularmicroqrcode`
- `royalmail`
- `swissqrcode`
- `symbol`
- `telepen`
- `telepennumeric`
- `ultracode`
- `upcacomposite`
- `upcecomposite`

## Liquid patterns {icon="point"}

**Loop over query rows**

```html
<table>
  <tbody>
    {% for row in rows %}
      <tr>
        <td>{{ row.Name }}</td>
        <td>{{ row.Status | default: "-" }}</td>
      </tr>
    {% endfor %}
  </tbody>
</table>
```

**Generic column table**

```html
<table>
  <thead>
    <tr>
      {% for column in columns %}
        <th>{{ column.label }}</th>
      {% endfor %}
    </tr>
  </thead>
  <tbody>
    {% for row in rows %}
      <tr>
        {% for column in columns %}
          <td>{{ row[column.key] | default: "-" }}</td>
        {% endfor %}
      </tr>
    {% endfor %}
  </tbody>
</table>
```

**Code 128 barcode**

```text
{% if rows.size > 0 and columns.size > 0 %}
  {% assign first = rows[0] %}
  {% assign codeColumn = columns[0] %}
  {% assign codeValue = first[codeColumn.key] | default: table.name %}
{% else %}
  {% assign codeValue = table.name %}
{% endif %}
<img alt="Asset barcode" src='{{ codeValue | barcode_data_url: "code128", true }}'>
```

**QR code**

```html
<img alt="Record QR code" src='{{ document.number | default: table.name | barcode_data_url: "qrcode" }}'>
```

## Preview, data, source {icon="layout-list"}

:::reference
- **Preview:** Renders the current unsaved draft as a PDF. Use **Open preview** for full-screen inspection.
- **Data:** Shows the exact Liquid paths for the selected preview record. Copy paths from here instead of guessing object shapes.
- **Source:** Shows the GQL after Liquid variables have been substituted. Use it to debug current-record filters.
:::

## Work with generated documents {icon="file-description"}

The document page lists every generated Document for a template. Use **Table** for a searchable list or **Folders** to browse by year and month. Searching switches to the table result so matching documents are not hidden inside folders.

Before generation you can add tags and, for an HTML template, override the filename. An E-Invoice renderer owns its artifact filenames. A completed Document's number, filename, tags, and artifacts are immutable.

Base Read allows browsing and redownloading generated documents. Base Write also allows generation. Base Admin manages templates. A Grids App reader may download only a Document for the current page record whose template is in that Record block's published capability. This App-scoped download does not grant the reader generic Base document access.

To share one generated PDF without a Cloud login, create a public link for 1, 7, 30, or 90 days. The link opens a minimal page with the document filename, its remaining validity, and a PDF download button. It never grants access to other documents or records. An optional comment explains the link's purpose to document editors. The creator or a document editor can revoke the link before it expires.

## Snapshots and stored Documents {icon="point"}

Generating a PDF creates a recursive snapshot of the root record and related records reached through relation fields. A snapshot includes at most four relation levels and 500 records. Grids renders once and stores the exact completed PDF bytes together with their SHA-256, MIME type, size, renderer version, template revision, document number, and source snapshot. Downloads return those stored bytes even after live records, the template, or the renderer change.

Use **Generate again** to create a new Document and its artifacts. It never replaces an older Document. Open the Document details to inspect its renderer, source Record, validation status, and artifact hashes.

:::reference
- **Document numbers:** Each Document receives a stable number. HTML templates use their configured number pattern; an E-Invoice renderer owns its numbering. Allocations are never reused; technical gaps are possible. Pattern changes affect future Documents only.
- **Template edits:** Changing a template affects future generations. Existing stored artifacts never render again.
- **Manual snapshots:** The record detail panel also has a Snapshot button for capturing a record state without generating a PDF.
- **Deleted templates:** Deleting a template removes it from the active list and archives its template-owned number series. Restoring an HTML template reconnects that series and its high-water mark. Existing generated Documents remain in the immutable catalog.
:::

## Practical limits {icon="point"}

Grids rejects templates that exceed these bounds instead of silently truncating a query or document:

| Input | Limit |
| --- | ---: |
| GQL source | 20,000 bytes |
| Body HTML | 200,000 bytes |
| Header HTML, footer HTML, or page CSS | 50,000 bytes each |
| Number or filename pattern | 5,000 bytes each |
| Rendered body HTML | 300,000 bytes |
| GQL result used by one document | 10,000 rows |
| Record images exposed to Liquid | 12 images, up to 2 MB each |
| Recursive snapshot | 4 relation levels and 500 records |

These are safety ceilings, not layout targets. For a document with thousands of rows, test page breaks and rendering time with realistic data before enabling the template.

## Common issues {icon="point"}

:::reference
- **Invalid GQL source:** Open the Source tab. It shows the GQL after Liquid variables were substituted.
- **Missing Liquid variable:** Choose a preview record, open Data, then copy the exact path from the tree.
- **Empty document rows:** Check the GQL source filter and confirm the selected preview record matches it.
- **Barcode does not render:** Check the barcode type and input value. Empty input returns an empty data URL.
- **Multipage layout breaks:** Move repeated content to header/footer, set @page margins, and preview with enough rows.
:::

:::note Use GQL for data, Liquid for layout
Keep filtering, sorting, joins, and grouping in GQL. Keep Liquid focused on loops, conditions, text, tables, images, barcodes, headers, footers, and CSS.
:::
