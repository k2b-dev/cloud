---
id: grids-documents-pdfs
title: Documents & PDFs
icon: ti ti-file-type-pdf
description: Create templates, generate PDF and data files, and inspect or share immutable documents.
order: 135
---
Document templates create PDFs from table records, for example invoices, contracts, and labels.

Each template belongs to one table and defines one document family. A generated document belongs to one selected record. It receives a stable number and filename and keeps the exact source snapshot after the live records change. It appears in the Documents section of the record, in its template workspace, and in the **All documents** catalog of the Base.

Use templates for formatted, shareable output. Use CSV or JSON exports for data exchange.

Workflows can also create one PDF from several records, free CSV, JSON, or XML, DATEV booking batches, and SEPA transfer files. All of them are documents, not only PDFs. [Workflows](/app/grids/help/grids-workflows) describes the header and mapping configuration.

E-Invoice output has the status **Not checked** (`unchecked`). The report names the checks that were not performed, including the validation of the generated XML and of the PDF attachment. Review this report before you use the output. SEPA XML is validated against its schema during generation. These checks do not certify the whole business process.

## Understand the immutable document model {icon="shield-check"}

Agents can find templates with `document.templates`, inspect stored documents with `document.list` and `document.read`, and issue one document for a selected record with `document.create`. Issuing requires **Edit** access, an idempotency key, and an individual approval. You cannot undo an issuance, and an approval never becomes a blanket approval. The returned download link requires your existing access. It does not create a public share link and does not send the document.

A retry with the same idempotency key returns the same immutable document. Reusing that key with different input fails.

### Issue once per finalized record

`issuancePolicy: "oncePerFinalizedRecord"` can be set only on creation. It reuses the frozen input, the number, and the document across keys and runs. Finalize first, then generate. If rendering fails, retry the generation for the same record and template. Do not reset or repeat the finalization. Grids checks access again. A live preview is not needed and can differ. The default is `repeatable`. Cloned templates have independent issuance scopes.

**Retry generation** locks the original inputs and the captured data. It uses no live preview. For `repeatable`, **Start a new attempt** uses the current data for another document. Check **All documents** first. Issuance once per record still reuses the original. People with **Edit** access can keep working with existing links, even without an enabled template.

### Choose a renderer

A template selects one renderer:

- The HTML renderer turns Liquid HTML and CSS into a PDF.
- An installed E-Invoice renderer maps the selected record through Liquid JSON. It then creates the PDF and the structured artifact together.

The renderer changes the artifacts that a document contains. It does not change the document model or how Grids generates, lists, inspects, or downloads documents.

Validation proves only the technical checks that the selected renderer and version name. It is not a general tax, accounting, signature, custody, or legal-compliance decision. Run `cld grids documents renderers --json` to see the renderers of this installation, including the `inputSchema` of each. `cld grids document-templates reference --json` provides the schemas for creating and updating templates. These schemas describe the structure of the input. The preview also checks the semantic rules of the renderer.

### Use the German E-Invoice renderer

`de.zugferd.en16931@1` renders outgoing EUR invoices for German seller and buyer addresses, standard VAT, and bank transfer. It creates PDF/A-3b with an embedded and a separate `factur-x.xml`. It targets ZUGFeRD 2.5 / Factur-X 1.09 EN 16931, with exact decimal strings and half-up rounding.

It does not support corrections, incoming invoices, exemptions, allowances, charges, prepayments, discounts, self-billing, or filings. The issuer must verify suitability; Grids does not certify legal compliance.

Version 2 (`de.zugferd.en16931@2`) also renders:

- credit notes with the number, date, and reason of the original invoice;
- self-billing with an agreement reference.

Version 2 requires an explicit document kind and service date. Quantities and amounts stay positive. The document kind decides whether the document is an invoice or a credit. In self-billing, the seller stays the supplier, and the buyer stays the customer who issues the document. Payment details name the intended receiving account. Grids does not infer it from the document kind.

The renderer does not check that an original invoice exists or that credit or commission amounts remain available. The issuing workflow must enforce these checks, also for concurrent requests. Rendering support alone is not a complete billing app. Existing templates and retries keep their selected version. You must update a template explicitly.

## Go from a record to a PDF {icon="table"}

The template separates data selection from rendering. **GQL** loads the rows and columns that the document can use. The selected renderer then receives either Liquid HTML and CSS or one Liquid JSON object.

**Pipeline**

```text
selected record
  -> fill record values into the GQL source
  -> run the GQL query
  -> render the selected HTML or E-Invoice input
  -> create the artifacts
  -> save the Document and source snapshot
```

Keep filtering, sorting, joins, grouping, and totals in GQL. Keep Liquid focused on wording and page layout.

For an E-Invoice template, choose its renderer and map the preview data in **Renderer input**. The editor expects one JSON object. Use the `json` filter for every inserted value, for example `"buyerReference": {{ record.id | json }}`. This keeps quotes and other characters valid JSON. The preview checks the input of the renderer and generates the PDF before you enable the template. It does not certify the output.

## Create your first template {icon="file-description"}

You need **Manage** access to the Base to create and edit templates.

:::steps
1. **Open templates:** Open the table in **Edit mode** and choose **Templates**. Templates belong to the table that they generate documents for.
2. **Choose a starter:** Pick the structure closest to the output that you need. Every starter stays fully editable.
3. **Select a preview record:** The same record anchors the rendered GQL, the **Data** tree, and the PDF preview.
4. **Inspect before you edit:** **Source** shows the GQL with inserted record values. **Data** shows the exact Liquid paths. **Preview** shows the PDF.
5. **Change one layer at a time:** Adjust the GQL when the data is wrong. Adjust Body, Header, Footer, or Page CSS when the layout is wrong.
6. **Preview representative data:** Test long text, missing values, many rows, and page breaks. The editor creates new templates disabled.
7. **Enable and test:** Then people with **Edit** access to the Base can select a record and generate a saved document.
:::

The selected preview record is only test context. When people generate a document later, they select the actual record. They can override the filename or add tags.

## Share one document between several records {icon="files"}

A workflow can create one file from several records. Grids stores the file once. It appears in the Documents section of each associated record, whether it is PDF, CSV, JSON, XML, SEPA, or DATEV. Open **Source records** in its details to inspect the captured record versions.

The source inspector shows the current readable names in stable order of public IDs. A missing captured version stays blank and does not appear as version zero. Evidence packages keep only source IDs and captured versions, not current names or deletion states. A package holds at most 10,000 source entries.

Source records and result rows are different counts. A join can repeat a record, and a total can combine many records into one row. A missing source count means that Grids captured no complete record association. It does not mean zero source records. Related addresses, customers, and other relations are not associated automatically.

A simple row query on a stored table captures its record identities automatically. For an aggregate or joined export, a workflow author can set `associatedData` to a previously captured row query. Grids does not run this selection again after generation. Source versions describe the captured state. Record links open the current record.

Membership in a document never gives access to the whole batch. People with access to the Base can inspect these documents. Grids Apps still expose only the documents that the published app explicitly allows for a record. Creating a SEPA file does not mean that its transfers are paid.

## Start from a starter {icon="square-plus"}

Starters are editable templates, not fixed document types. Pick the closest structure. Then change the GQL source and the Liquid parts until the generated PDF matches the records in the table.

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

## Edit the parts of a template {icon="table"}

A template has one data part and up to four layout parts. Grids renders the GQL source with Liquid first. The source can therefore use the selected `record`, the public `app` values, and the `business` values of the Base before Grids parses the query.

| Part | Language | Purpose | Common use |
| --- | --- | --- | --- |
| GQL source | Liquid + GQL | Selects the rows and columns available to the document. Liquid is rendered before GQL is parsed. | Current record, joined rows, item lists, grouped summaries. |
| Body | Liquid + HTML | Main printable content for the HTML renderer. | Invoice body, contract clauses, label layout, record detail tables. |
| Header | Liquid + HTML | Optional header shown on each page. | Letterhead, sender identity, document class, contact block. |
| Footer | Liquid + HTML | Optional footer shown on each page. | Legal footer, bank data, and page placeholders such as `<span class="pageNumber"></span>` and `<span class="totalPages"></span>`. |
| Page CSS | Liquid + CSS | Optional CSS injected into the PDF body document. | @page size/margins, table headers, page breaks, print typography. |

PDFs render offline. Scripts do not run, and remote images, stylesheets, and fonts do not load. For images, use record images, `barcode_data_url`, or other `data:` URLs. `app.logoDataUri` prints the logo uploaded in the Cloud administration. A logo set as a web address does not load.

## Understand the available data {icon="layout-grid"}

The **Data** tab is the source of truth for the current preview record. It shows the exact shape that Liquid receives after the GQL source has run. Copy paths from this tree. Do not guess object shapes.

Think of the data in layers. `record` is the selected record. `rows` and `columns` are the GQL result. `document` describes a saved document. `template`, `document`, and `date` provide stable metadata for numbers and filenames. `app` contains public platform branding. `business` contains the shared document details of the Base. Rows also expose the GQL output labels, so readable aliases make templates easier to maintain.

:::reference
- **record:** The current record: public `record.id` and `record.tableId`, `record.version`, `record.data`, and the created and updated timestamps.
- **rows and columns:** The rows and columns that the GQL source returns. Use `column.key` to access a row and `column.label` for readable headers.
- **template, document, date:** Stable metadata for patterns and document text: `{{ template.name }}`, `{{ template.id }}`, `{{ document.id }}`, `{{ date.iso }}`, and `{{ date.yyyyMMdd }}`. Draft previews use draft document values until a document exists.
- **app:** Public platform values for document branding: `{{ app.name }}`, `{{ app.contactEmail }}`, `{{ app.url }}`, `{{ app.logoDataUri }}`, and `{{ app.timezone }}`.
- **business:** Document details of the Base, configured in **Base settings → Documents**. `business.legalName` is the explicit issuer name. When it is not set, it stays empty and never inherits `app.name`. `business.address` contains the street and building lines, as entered. Use `business.postalCode`, `business.city`, and `business.countryCode` separately. The tax number and the VAT ID are separate (`business.taxId`, `business.vatId`). `business.accountName` is the account holder, together with `business.iban`, `business.bic`, and `business.bankName`. The sender line, payment terms, footer, and contact fields stay available.
- **images:** Image files attached to file fields of the selected record. Use `{{ primaryImage.url }}` for the first supported image, or loop over `images`. Grids leaves out oversized and unsupported files.
- **document:** Document metadata such as `{{ document.number }}` and `{{ document.createdAt }}`. Use it in filenames and in the body, header, or footer HTML after the number pattern has rendered. Draft previews can lack final values.
- **snapshot:** The captured record graph of a generated document. It is null in live draft previews.
- **barcode_data_url:** A Grids Liquid filter for labels and badges. It returns an SVG data URL for QR codes and supported BWIP barcode symbols.
:::

## Write GQL sources {icon="code"}

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

## Set numbers and filenames {icon="paperclip"}

A generated document has a stable `document.number`. An HTML template owns a durable number series. Grids renders its number pattern first. Its filename pattern can then use `{{ document.number }}`. An E-Invoice renderer owns its numbering and artifact filenames.

The default HTML number pattern is `{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}`. A custom pattern can use the allocated `{{ series.value }}`. Allocations increase atomically and are never reused, but rollbacks and technical failures can leave gaps. A number pattern alone does not establish legal compliance.

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
- **Number pattern context:** Can use `record`, `table`, `template`, `document`, `series`, `date`, `app`, and `business`. `series.id` is the public series ID, and `series.value` is the allocated number. `document.id` is already available. `document.number` is the result being calculated, so it is not available yet.
- **Filename pattern context:** Can use the full rendered data tree, including `{{ document.number }}`. Grids cleans the final filename for safe PDF downloads.
- **Validation:** Saving a template fails for unknown top-level Liquid variables, invalid tags, unsupported filters, empty patterns, and oversized patterns.
:::

## Use Liquid {icon="book-2"}

Template parts use Liquid with Grids restrictions: strict variables, strict filters, escaped output, no layouts, no dynamic partials, and only the tags listed below. Unknown filters, invalid tags, and oversized output fail and never create a partial document.

:::reference
- **Output:** Use `{{ value }}` to print a value. Output is HTML-escaped by default. Use `| raw` only when a trusted template prints HTML on purpose.
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

## Add barcodes and QR codes {icon="code"}

Use the `barcode_data_url` filter in an `<img>` tag. Barcode IDs are lowercase symbols. The optional third argument controls the readable text for barcode formats that support it.

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

| Type id | Label | Use |
| --- | --- | --- |
| `code128` | Code 128 | General-purpose linear barcode. |
| `qrcode` | QR Code | Compact 2D code for phones. |
| `datamatrix` | Data Matrix | Small 2D code for labels. |
| `pdf417` | PDF417 | Stacked 2D code for documents. |
| `azteccode` | Aztec Code | Dense 2D code without quiet zone. |
| `ean13` | EAN-13 | Retail product code, 13 digits. |
| `ean8` | EAN-8 | Short retail product code. |
| `upca` | UPC-A | US retail product code. |
| `upce` | UPC-E | Compressed UPC code. |
| `itf14` | ITF-14 | Carton and package code. |
| `gs1datamatrix` | GS1 Data Matrix | GS1 2D code with GS1 identifiers such as `(01)`. |
| `sscc18` | SSCC-18 | Shipping container code. |
| `isbn` | ISBN | Book identifier barcode. |
| `issn` | ISSN | Serial publication barcode. |
| `ismn` | ISMN | Printed music barcode. |
| `code39` | Code 39 | Simple alphanumeric barcode. |
| `code93` | Code 93 | Compact alphanumeric barcode. |
| `interleaved2of5` | Interleaved 2 of 5 | Numeric warehouse barcode. |
| `micropdf417` | MicroPDF417 | Compact stacked 2D code. |
| `microqrcode` | Micro QR Code | Tiny QR variant. |
| `maxicode` | MaxiCode | Parcel and logistics 2D code. |
| `dotcode` | DotCode | Dot-based production code. |

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

## Reuse Liquid patterns {icon="point"}

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

## Check the preview, data, and source {icon="layout-list"}

:::reference
- **Preview:** Renders the current unsaved draft as a PDF. Use **Open preview** for a full-screen check.
- **Data:** Shows the exact Liquid paths for the selected preview record. Copy paths from here. Do not guess object shapes.
- **Source:** Shows the GQL after Grids substituted the Liquid variables. Use it to debug filters for the current record.
:::

## Work with generated documents {icon="file-description"}

The document page of a template lists every document that the template generated. Use **Table** for a searchable list or **Folders** to browse by year and month. A search switches to the table result, so folders never hide matching documents.

**All documents** lists every document of the Base in any file format, whether a template, a workflow, or both produced it. It opens in **Folders**, grouped by document template or workflow and then by year. Its search covers filenames, document numbers, and tags of the whole Base, regardless of the open folder. Both document pages include their first results when the page loads.

### Filter and sort all documents

Filter **All documents** by **Workflow**, **Template**, **Record table**, and **File type**. Combine the filters to narrow the list.

- **Record table** matches only documents generated for a record of that table. It does not match the source rows of a workflow export or the files inside a ZIP.
- **Sort** switches between newest first (the default), oldest first, and filename.

A search, a filter, or a different sort shows one list instead of folders. The address keeps all of them, so a reload or a shared link opens the same view.

A document from a workflow names its workflow. Select the name to open the run that generated it. The details of a ZIP document list its **Archive contents**: each packaged file, its size, and the document that it came from. Grids does not link the archive to the records of those documents.

### Inspect document details

Document details offer the stored downloads, the captured row count, and the timestamp.

- **Preview** shows CSV, JSON, and XML up to 2 MiB. Larger files stay downloadable. CSV stays original text.
- **Copy** copies the file.
- **Share links** creates public links for the stored primary file.
- **Technical details** shows IDs and hashes.
- **More actions → Generate again** follows the issuance policy of the template and never overwrites the original.

Subdialogs return to the details.

Before generation, you can add tags. For an HTML template, you can also override the filename. An E-Invoice renderer owns its artifact filenames. A completed Document's number, filename, tags, and artifacts are immutable.

The main download keeps the stored file format. Share links serve the same primary file, whether it is a PDF, CSV, JSON, or XML document. They always serve it as a download, never as a page in the browser. In the input of a profile renderer, `document.filename` is `null`, because the renderer has not produced its files yet. Read the filename of the completed document after generation.

### Control access to documents

- **View** access to the Base allows browsing and downloading generated documents again.
- **Edit** access also allows generation.
- **Manage** access is required to create and change templates.

A person who uses a Grids App can download only a document for the current page record. Its template must be in the published capability of that Record block. This app-scoped download gives no general access to the documents of the Base.

### Share a document with a public link

To share one generated document without a Cloud sign-in, create a public link for 1, 7, 30, or 90 days. The link opens a minimal page with the filename of the document and its remaining validity. A button downloads the stored primary file in its original format. It never gives access to other documents or records. An optional comment explains the purpose of the link to people who edit documents. The creator, or a person who can edit documents, can revoke the link before it expires.

## Rely on snapshots and stored documents {icon="point"}

Generating a PDF creates a recursive snapshot of the root record and the related records reached through relation fields. A snapshot includes at most four relation levels and 500 records. Grids renders once and stores the exact completed PDF bytes with their SHA-256, MIME type, size, renderer version, template revision, document number, and source snapshot. Downloads return those stored bytes, even after the live records, the template, or the renderer change.

**Generate again** depends on the issuance policy. `repeatable` creates another document. `oncePerFinalizedRecord` returns the original, also after template edits. Details show the renderer, the source, the validation, and the hashes.

:::reference
- **Document numbers:** Each document receives a stable number. HTML templates use their configured number pattern. An E-Invoice renderer owns its numbering. Allocations are never reused, but technical gaps are possible. Pattern changes affect only future documents.
- **Template edits:** Changing a template affects future generations. Existing stored artifacts never render again.
- **Manual snapshots:** The record detail panel also has a **Snapshot** button. It captures a record state without generating a PDF.
- **Deleted templates:** Deleting a template removes it from the active list and archives its number series. Restoring an HTML template reconnects that series and its highest number. Existing generated documents stay in the immutable catalog.
:::

## Know the practical limits {icon="point"}

Grids rejects templates that exceed these bounds. It never truncates a query or a document silently:

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

These are safety ceilings, not layout targets. For a document with thousands of rows, test page breaks and rendering time with realistic data before you enable the template.

## Fix common issues {icon="point"}

:::reference
- **Invalid GQL source:** Open the **Source** tab. It shows the GQL after Grids substituted the Liquid variables.
- **Missing Liquid variable:** Choose a preview record, open **Data**, and copy the exact path from the tree.
- **Empty document rows:** Check the filter of the GQL source and confirm that the selected preview record matches it.
- **Invalid E-Invoice details:** The message names the affected party, bank, or document fields. Correct and save their source records, then try again. If the values are already correct, check the **Renderer input** mapping of the template. A preview does not allocate an official number.
- **Barcode does not render:** Check the barcode type and the input value. An empty input returns an empty data URL.
- **Multipage layout breaks:** Move repeated content to the header or footer, set @page margins, and preview with enough rows.
:::

:::note Use GQL for data, Liquid for layout
Keep filtering, sorting, joins, and grouping in GQL. Keep Liquid focused on loops, conditions, text, tables, images, barcodes, headers, footers, and CSS.
:::

## Read stored files as an agent {icon="file-description"}

Agents use `document.content.read` for stored PDF, XML, or CSV bytes. Choose an artifact key from `document.read`, or leave it out for the primary file. Code mode reads the returned stream as a File, with a limit of 50 MiB per file. Downloading does not extract PDF text and does not issue or send a document. At download, Grids checks again that you can still read the document.

## Download a folder {icon="download"}

In the folder view, choose **Download folder as ZIP** next to a template, a year, or a month. The archive contains the stored primary file of each document, including subfolders. You can cancel while Grids collects the files.

- The limit is 1,000 documents and 100 MiB. Use smaller subfolders for larger collections.
- A failed transfer saves no partial archive.
- Additional artifacts stay individual downloads.

This reads the current folder contents. It is not a frozen backup.
