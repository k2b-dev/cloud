# Grids Documents, templates, and export files

Use this reference to author a template, generate an immutable file, or choose a
workflow export format. Use [Grids](grids.md) for workflow inputs, expressions,
query captures, permissions, retention, and evidence packages.

## Find the contract before writing

```bash
cld grids document-templates reference --json
cld grids documents renderers --json
cld grids workflows reference --json
cld api-docs operations grids --json
```

The first command describes template inputs. The installed renderer catalog
selects the exact renderer ID/version and input contract. The workflow reference
describes `generateDocument` and its output variants. Use the app API documentation
for response shapes and operations not exposed by a dedicated CLI command. Do not
copy a response DTO into a create body: IDs, timestamps, series, artifacts,
validation results, and source counts are server-owned.

Task map:

- [Create or edit templates](#create-or-edit-templates)
- [Liquid data, filters, and barcodes](#liquid-data-filters-and-barcodes)
- [Numbers, filenames, and business defaults](#numbers-filenames-and-business-defaults)
- [Preview and generate](#preview-and-generate)
- [Browse, download, and share](#browse-download-and-share)
- [Batch PDFs and free CSV/JSON/XML](#batch-pdfs-and-free-csvjsonxml)
- [SEPA transfers and DATEV bookings](#sepa-transfers-and-datev-bookings)
- [E-invoices, corrections, and self-billing](#e-invoices-corrections-and-self-billing)
- [Limits and recovery](#limits-and-recovery)

Financial serializers use the public stdlib implementation. Grids owns
permissions, frozen inputs, numbering, approval and export claims. Invoice PDFs
are rendered by Gotenberg; Grids does not run post-render XSD or embedded-XML
verification. An `unchecked` validation status is not a compliance certificate.
Use `grids-financial-formats` Help for supported inputs and format limits.

## Create or edit templates

A template belongs to one table. Record-template generation selects one root
record; its GQL may select multiple rows. A workflow's captured-data output can
instead generate one file without any record template. Both produce the same
immutable Document model. Documents are not limited to PDFs.

Template input:

| Property | Create | Update | Meaning |
| --- | --- | --- | --- |
| `name` | Required, 1–200 characters | Optional | Template label |
| `description` | Optional, nullable, max 2,000 | Optional, nullable | Description |
| `source` | Required, nonempty, max 20,000 | Optional | Liquid-rendered GQL |
| `renderer` | Required | Optional | Complete HTML or profile variant below |
| `enabled` | Optional boolean | Optional boolean | Permit normal generation |
| `position` | Not accepted | Optional integer | Ordering |

The API defaults a new template to enabled; the visual editor starts disabled.
For agent authoring, explicitly set `enabled: false`, preview, then enable. Unknown
properties in template bodies and renderer objects are rejected. Updating a
renderer supplies the complete selected variant, not a recursive partial patch.

HTML renderer:

```json
{
  "kind": "html",
  "body": "<h1>{{ template.name }}</h1><p>{{ document.number }}</p>",
  "numberTemplate": "{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}",
  "filenameTemplate": "{{ document.number }}.pdf"
}
```

Required: `kind`, `body`, `numberTemplate`, `filenameTemplate`. Optional `header`,
`footer`, and `css` are nonempty strings when supplied; omit unused parts rather
than passing empty strings. Header/footer repeat on pages. Footer page counters
use `<span class="pageNumber"></span>` and `<span class="totalPages"></span>`.
Use CSS for `@page` size/margins, page breaks, and repeated table headers.

Profile renderer:

```json
{
  "kind": "profile",
  "id": "de.zugferd.en16931",
  "version": 2,
  "inputTemplate": "...one complete Liquid JSON object matching this profile..."
}
```

This illustrates the shape, not valid invoice input. `id` is a renderer identifier,
not a six-character Grids resource ID. `version` is a positive integer selecting
an installed version. `inputTemplate` renders one JSON object; use `| json` for
inserted values rather than assembling JSON quotes by hand. Profiles own their
numbering and artifact filenames; HTML number/filename settings do not apply.

Create `template.json` with the following content after selecting the actual table:

```json
{
  "name": "Invoice overview",
  "enabled": false,
  "source": "from table Invoices\nwhere record.id = '{{ record.id }}'\nlimit 1",
  "renderer": {
    "kind": "html",
    "body": "<h1>{{ template.name }}</h1>{% for row in rows %}{% for column in columns %}<p>{{ column.label }}: {{ row[column.key] }}</p>{% endfor %}{% endfor %}",
    "numberTemplate": "{{ template.id }}-{{ date.yyyyMMdd }}-{{ document.id }}",
    "filenameTemplate": "{{ document.number }}.pdf"
  }
}
```

```bash
cld grids document-templates create --base BASE_ID --table Invoices --body-file template.json
cld grids document-templates list --base BASE_ID --table Invoices --full --json
cld grids document-templates get --base BASE_ID --table Invoices --template TEMPLATE_ID --json
cld grids document-templates update --base BASE_ID --table Invoices --template TEMPLATE_ID --enabled
```

Replace uppercase IDs with actual public IDs. Names resolve within the selected
table/Base; explicit IDs avoid ambiguity. `list --full` requires admin access.
Create/update accept `--body`, `--body-file`, or `--stdin`. Convenience flags are
`--name`, `--description`, `--source`, `--html`, `--header-html`, `--footer-html`,
`--page-css`, `--number-template`, `--filename-template`, `--enabled`, `--disabled`;
update also accepts `--position`. Prefer JSON for complete renderer configuration.
Do not assume create/update have the draft-preview `--html-file` flags.

`document-templates delete` soft-deletes the template. Stored Documents remain;
the template's owned series is archived, not reset. Use API discovery for restore
and reorder operations; do not invent `document-templates restore` or `reorder`
CLI commands.

## Liquid data, filters, and barcodes

Inspect `preview-data` before choosing paths. The source query is rendered first;
the body/profile sees the resulting rows. Keep filtering, joins, sorting, grouping,
and financial calculations in GQL rather than layout Liquid.

| Rendering stage | Available top-level roots |
| --- | --- |
| GQL source | `record`, `table`, `app`, `business`, `template`, `date` |
| HTML number pattern | Those roots plus `document`, `series` |
| Body/header/footer/CSS, filename, profile input | `record`, `table`, `rows`, `columns`, `query`, `document`, `snapshot`, `app`, `business`, `images`, `primaryImage`, `template`, `date` |
| Workflow captured-data PDF/XML | Only `rows`, `columns`, `document` |

Important paths:

- `record.id`, `record.tableId`, `record.version`, `record.data`, timestamps.
  Use preview data to find actual field IDs/labels; never assume relation IDs are
  expanded objects.
- `columns[].key` addresses `row[column.key]`; `columns[].label` is presentation.
  Query results also have labels available where projected for template use, but
  `row[column.key]` works independently of aliases and spaces.
- `query.rows`/`query.columns` contain the result also exposed as `rows`/`columns`.
- `template.id`, `template.name`; `document.id`, `document.number`,
  `document.createdAt`. A profile input has `document.filename: null` until its
  renderer creates the files.
- `date.iso`, `date.date`, `date.yyyy`, `date.year`, `date.month`, `date.day`,
  `date.yyyyMMdd`. Calendar values follow the rendering date context.
- `app.name`, `app.contactEmail`, `app.url`, `app.logoDataUri`, `app.timezone`:
  public platform branding, not private settings.
- `business`: Base document defaults described below.
- `images` and nullable `primaryImage`: supported attached root-record images;
  each includes a usable `url`. Check availability before rendering an image.
- `snapshot`: captured record graph for issued record-template Documents, null in
  live previews. Its recursive relations do not imply document membership.

Liquid is strict: unknown variables/filters fail. HTML output is escaped by
default. Use `raw` only for trusted intentional HTML. Do not assume other template
languages' functions or JavaScript execution.
The Grids-specific filters are `json` (JSON serialization, null for nullish input)
and `barcode_data_url`. Profile JSON rendering uses JSON serialization rather than
HTML escaping; XML has its own stricter escaping rules below.

The current engine's built-in filters are listed below. These are template
operations, not a replacement for GQL's exact money calculations:

| Family | Filters |
| --- | --- |
| Numbers | `abs`, `at_least`, `at_most`, `ceil`, `divided_by`, `floor`, `minus`, `modulo`, `plus`, `round`, `sum`, `times`, `to_integer` |
| Text | `append`, `capitalize`, `downcase`, `lstrip`, `newline_to_br`, `normalize_whitespace`, `number_of_words`, `prepend`, `remove`, `remove_first`, `remove_last`, `replace`, `replace_first`, `replace_last`, `rstrip`, `slugify`, `split`, `strip`, `strip_html`, `strip_newlines`, `truncate`, `truncatewords`, `upcase` |
| Lists and selection | `array_to_sentence_string`, `compact`, `concat`, `find`, `find_exp`, `find_index`, `find_index_exp`, `first`, `group_by`, `group_by_exp`, `has`, `has_exp`, `join`, `last`, `map`, `pop`, `push`, `reject`, `reject_exp`, `reverse`, `sample`, `shift`, `size`, `slice`, `sort`, `sort_natural`, `uniq`, `unshift`, `where`, `where_exp` |
| Dates | `date`, `date_to_long_string`, `date_to_rfc822`, `date_to_string`, `date_to_xmlschema` |
| Encoding and output | `base64_decode`, `base64_encode`, `cgi_escape`, `default`, `escape`, `escape_once`, `hmac_sha256`, `inspect`, `json`, `jsonify`, `raw`, `sha256`, `uri_escape`, `url_decode`, `url_encode`, `xml_escape` |

`json` is overridden by Grids as described above. Preview filter arguments with
representative data; unknown filters fail rather than being ignored.

Allowed tags are `if/elsif/else/endif`, `unless/endunless`,
`for/break/continue/endfor`, `case/when/endcase`, `assign`, `capture/endcapture`,
`comment/endcomment`, and `raw/endraw`. No includes, layouts, dynamic partials,
filesystem loading, or external template imports.

```html
{% for row in rows %}
  {% for column in columns %}
    <p>{{ column.label }}: {{ row[column.key] | default: '-' }}</p>
  {% endfor %}
{% endfor %}
<img alt="Document QR code"
     src="{{ document.number | barcode_data_url: 'qrcode' }}">
```

`value | barcode_data_url: symbol, showText` returns an SVG data URL. Symbol defaults
to `code128`; `showText` defaults to false and must be a boolean. Empty input
returns an empty URL. Common symbols: `code128`, `qrcode`, `datamatrix`, `pdf417`,
`azteccode`, `ean13`, `ean8`, `upca`, `upce`, `itf14`, `gs1datamatrix`, `sscc18`,
`isbn`, `issn`, `ismn`, `code39`, `code93`, `interleaved2of5`, `micropdf417`,
`microqrcode`, `maxicode`, `dotcode`. Symbols enforce their own input constraints
(for example EAN digit/checksum requirements). The in-app **Documents & PDFs →
Barcodes and QR codes** help lists additional supported BWIP symbol IDs. Read that
help for a less common symbol rather than guessing an alias.

## Numbers, filenames, and business defaults

HTML templates own a durable number series. The number pattern runs first;
`series.id` and the allocated `series.value` are available there. The result then
becomes `document.number` for the filename and content. Do not reference
`document.number` while calculating the number itself.

`INV-{{ date.yyyy }}-{{ series.value }}` is a sequential number pattern. Adding
the year to the text does not request a yearly series reset. Series allocations
increase atomically and are never reused; technical failures can leave gaps.
The pattern is not a legal-compliance or gaplessness guarantee. A generated `id`
field's finalization-time assignment is a separate feature, not this series.

Filename example: `invoice-{{ document.number }}.pdf`. Generation may override an
HTML filename; profile renderers reject that override. Patterns are validated on
save, numbers are cleaned, and download filenames are made filesystem-safe.
Pattern edits affect future Documents only. Restore reconnects an HTML template's
series/high-water mark rather than starting at one again.

Base `documentDefaults` supplies `business` to templates. All properties are
optional strings; limits in characters:

| Properties | Maximum each |
| --- | ---: |
| `legalName`, `department`, `bankName` | 200 |
| `senderLine`, `url`, `paymentTerms` | 500 |
| `address`, `footerText` | 1,000 |
| `contactEmail` | 320 |
| `phone`, `taxId`, `iban`, `bic` | 100 |
| `registration` | 300 |

Set them through Base update JSON (`documentDefaults`) or Base settings →
Documents. They are reusable text defaults, not validated bank/accounting data.
An E-invoice or SEPA profile still validates its separate structured inputs.

## Preview and generate

```bash
cld grids document-templates preview-data --base BASE_ID --table Invoices --template TEMPLATE_ID --record RECORD_ID --json
cld grids document-templates preview-pdf --base BASE_ID --table Invoices --template TEMPLATE_ID --record RECORD_ID --out preview.pdf
cld grids documents generate --base BASE_ID --table Invoices --template TEMPLATE_ID --record RECORD_ID --idempotency-key invoice-attempt-1 --tag invoice --out issued.pdf
```

Preview returns rendered `source`, HTML, and `data`; it does not issue a Document.
Profile preview also validates the selected profile. Unsaved previews use
`document-templates preview-draft-data|preview-draft-pdf` with `--record` and
`--body-file`, or source/layout overrides. A draft body contains `source`,
`renderer`, `recordId`. Draft previews support `--source-file`, `--html-file`,
`--header-html-file`, `--footer-html-file`, `--page-css-file` and their inline
counterparts. Supplying a saved `--template` provides defaults for omitted parts.
PDF preview requires `--out`.

Generation requires Base Write, an enabled template, and an idempotency key of
1–200 characters. Optional tags: at most 20, each 1–40 characters. Optional
filename: 1–255 characters. Reuse the same key and original input to recover the
same attempt; changed input with the same key conflicts. A new key can issue a
second Document. Check the catalog before abandoning an ambiguous attempt.
Retries after capture use the stored source/configuration, not current edits.

## Browse, download, and share

```bash
cld grids documents list --base BASE_ID --limit 100 --json
cld grids documents list-by-template --base BASE_ID --table Invoices --template TEMPLATE_ID --q invoice --json
cld grids documents browse --base BASE_ID --table Invoices --template TEMPLATE_ID --mode folders --path 2026/09 --json
cld grids documents by-record --base BASE_ID --table Invoices --record RECORD_ID --json
cld grids documents get DOCUMENT_ID --json
cld grids documents sources DOCUMENT_ID --offset 0 --limit 100 --json
cld grids documents download DOCUMENT_ID --out document.pdf
cld grids documents download-artifact DOCUMENT_ID xml --out invoice.xml
```

Download extensions above are examples: preserve the actual artifact filename and
MIME type. `download` returns the primary stored artifact, not always PDF. Read
`artifacts[].key` before selecting `download-artifact`; `xml` is not universal.

List pages use a cursor (default 50, maximum 100). Template list/browse supports
`--q`/`--query`, repeated `--tag`, `--cursor`, `--limit`; browse adds
`--mode list|folders` and year/month `--path`. `documents browse` is currently a
template-scoped command. The GUI's **All documents** instead defaults to folders
by source/template then year and searches across the Base; discover its Base
browse API rather than passing a Base path to the template command.

Document responses include `id`, `baseId`, nullable `tableId/recordId/templateId`,
`number`, `filename`, creation metadata, `tags`, `renderer`, `validationStatus`,
`primaryArtifactKey`, `artifacts`, `sourceRecordCount`, and nullable `dataSnapshot`
(`rowCount`, `capturedAt`). Artifact metadata contains `key`, `filename`, `mimeType`,
`sizeBytes`, `sha256`. These are read-only; completed metadata and bytes are not
editable. Regenerate to make a new Document.

One batch file may belong to several records and appear in each record's Documents
section. `sourceRecordCount` counts associated records, not query rows. Null means
no complete association was captured, not zero. Joins can duplicate records and
aggregates can collapse many into one row. Relations are not automatically
associated. `documents sources` paginates captured versions; readable current
labels are for navigation, not a replacement for historical values. For explicit
batch membership use workflow `associatedData`; for freshness checks before a
financial export use `sourceVersions`. They solve different problems; see the
workflow section of [Grids](grids.md).

Base Read permits browsing/download. Base Admin manages templates; Base Write
generates and manages document links. A published Custom App exposes only its
authorized record/template documents, not generic access to an entire batch/Base.

```bash
cld grids documents links list DOCUMENT_ID --json
cld grids documents links create DOCUMENT_ID --expires-in 7d --comment 'Customer copy' --json
cld grids documents links revoke LINK_ID
```

Public links require a primary PDF. Lifetimes: `1d`, `7d`, `30d` (default), `90d`.
The complete URL is returned only at creation: save/copy it then, not in a public
log. Later list results contain lifecycle metadata, not a reconstructable URL.
Revocation invalidates the link; ask for approval before doing it. Creating a link
does not send it. Non-PDF outputs require authorized downloads.

## Batch PDFs and free CSV/JSON/XML

Workflow `generateDocument` has two mutually exclusive modes: `template` +
`record`, or captured `data` + `output`. Never mix them. Data can be a saved GQL
capture, typed literal rows, issued-Document snapshots, or manual Record snapshots;
see [Grids workflow data sources](grids.md#build-and-operate-workflows). One capture can feed several
formats without querying again.

```yaml
steps:
  - query:
      source: |
        from table Items
        select Name, Status
        sort Name asc
      saveAs: report
  - generateDocument:
      data: report
      output:
        kind: csv
        delimiter: ";"
      filename: inventory.csv
      saveAs: exported
```

Output variant fields:

| `kind` | Required fields besides `kind` | Optional fields/defaults |
| --- | --- | --- |
| `csv` | None | `delimiter`: comma(default), semicolon, tab(`"\t"`), pipe; `nestedValues`: `reject`(default)/`json`; `textProtection`: `spreadsheet`(default)/`raw`; `columns` mapping |
| `json` | None | `wrapper: {rowsKey, values}`; `values` defaults to `{}` |
| `pdf` | `body` | `header`, `footer`, `css` |
| `xml` | `body` | None |

CSV mapping is `columns: [{source: Amount, label: Total}, {source: Name}]`:
select/order/rename exact GQL aliases. Omit it to use all columns; duplicate or
unknown sources/headings fail. CSV uses UTF-8 and CRLF, null becomes an empty
cell. Nested values fail unless explicitly encoded as JSON. Spreadsheet protection
prefixes potentially executable text with an apostrophe and reports protected
cells; it does not rewrite genuine numeric values. `raw` disables that safeguard.

JSON uses unique aliases as object keys, preserving booleans, null, arrays, and
exact decimal strings. A wrapper produces one object with a row array at `rowsKey`
plus `values`; `values` must not overwrite that key. Values can use workflow
expressions. Rows are not JSON-stringified twice.

PDF body/header/footer/CSS see only `rows`, `columns`, `document.number`, and
`document.createdAt`; access each row by its column key. Nested object-list cells
can be iterated explicitly. There is no implicit live `record` or relation query.

XML is UTF-8 XML 1.0 with one root. Static names/namespaces; dynamic values only
in text and quoted attributes. Loops/conditions/scalar assignments are allowed.
DTDs, CDATA, dynamic markup, raw/capture/comment Liquid blocks, and processing
instructions other than a static XML declaration are rejected. XML comments must
be static. Free XML is not a validated SEPA or E-invoice profile.

## SEPA transfers and DATEV bookings

Use `output: {kind: sepa-xml|datev-csv, version: 1, header, mapping}` with captured
data. Financial profiles are deliberately unavailable through record-template
generation: they require a manual workflow run and review confirmation. Scheduled
and record-event financial workflows are rejected.

`mapping` maps required profile property names to exact query column aliases,
not values, expressions, or `q_col_*` keys. Header values may use workflow
expressions except `destinationKey`, which must be a stable literal identity for
the actual accounting ledger/payment account. Never change it to bypass duplicate
export protection.

### SEPA version 1

SCT `pain.001.001.09`, pinned DK GBIC 5 schema; EUR only. One file contains multiple
transfers. Required `filename` ends in `.xml`.

Header: `destinationKey`, `debtorName` (1–70), valid uppercase electronic
`debtorIban`, `executionDate` (`YYYY-MM-DD`); optional valid `debtorBic`.
Mapping: `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban`,
`remittance`; optional `creditorBic`.

Transfer constraints: unique `businessId` and unique `endToEndId` per batch;
`endToEndId` up to 35 SEPA basic characters, no leading/trailing `/` or `//`;
creditor name up to 70, remittance up to 140; valid SEPA IBAN without spaces,
no QR-IBAN. Amount is positive exact money, at most 999,999,999.99, no fractional
cents. Grids generates message/payment-information IDs. Past execution dates
produce preview warnings, not automatic rewriting. Unsupported characters are
rejected. Names/remittance permit letters A–Z/a–z, digits, spaces, basic
`+ ? / : ( ) . , ' -` and the DK extensions `& * $ % Ä Ö Ü ä ö ü ß`.
Other characters, such as `é` or `€`, fail validation; Grids never transliterates
them. Payment IDs remain restricted to the basic character set.

### DATEV version 1

DATEV 700/13 EUR booking batch, UTF-8 with BOM. Required filename matches
`EXTF_*.csv`, for example `EXTF_reimbursements.csv` — `reimbursements.csv` fails.

Header properties (all required):

- `destinationKey`: stable ledger identity.
- `consultantNumber`: digit string, 4–7 digits, at least 1001; `clientNumber`:
  digit string, 1–5 digits, nonzero first digit.
- `fiscalYearStart`, `periodStart`, `periodEnd`: ISO dates in 2000–2099;
  period ordered and inside that fiscal year.
- `accountLength`: integer 4–8; `label`: 1–30 characters from letters, digits,
  underscore, dot, dash, slash, space.
- `finalize`: boolean controlling DATEV import finalization, not Grids record
  finalization.

Required mappings: `businessId`, `entryId`, `amount`, `direction`, `account`,
`counterAccount`, `documentDate`, `documentNumber`. Optional: `text`, `taxKey`,
`costCenter1`, `costCenter2`.

Amounts are positive exact money, at most 9,999,999,999.99; direction is `S` or `H`,
not a negative amount. Account values are nonzero digit strings, up to 9 digits
and at most `accountLength + 1`. `documentDate` falls inside the posting period.
`documentNumber` is 1–36 ASCII letters/digits or `_ $ & % * + - /` (no spaces).
`text` max 60; `taxKey` exactly four digits; cost centers max 36 letters, digits,
underscore, or spaces. One business event may contain several postings, each with
a unique `entryId` within that event.

Both profiles accept 1–10,000 rows. `businessId`/`destinationKey` (and DATEV
`entryId`) are nonempty, up to 200 characters, with no surrounding whitespace or
control characters. Capture exact decimals; profiles refuse to round fractional
cents. Neither profile uploads to a bank, marks payments paid, nor imports into
DATEV/ADDISON. Confirm the target system's import settings with its operator;
technical validation does not guarantee acceptance or legal/accounting correctness.

### Confirm and continue safely

```bash
cld grids workflow-runs steps RUN_ID
cld grids workflow-runs preview-export RUN_ID RECEIPT_ID --json
cld grids workflow-runs confirm-export RUN_ID RECEIPT_ID --sha256 REVIEWED_HASH --yes
cld grids workflow-runs get RUN_ID
```

Review all rows, totals, profile/version, destination, dates, warnings, and explicit
query limits. Confirm only after user approval, with the returned hash and the same
account/access method that launched the run. Confirmation resumes work; wait for
actual successful issuance before reporting a file created. Permissions and any
`sourceVersions` guards are checked again. Closing the review leaves the run
waiting; cancel explicitly to abandon it.

Completed financial exports reserve business identities for the Base, destination,
and accounting/payment purpose. Re-download the completed Document instead of
creating another export of the same events. Failed attempts without issuance do
not permanently claim events. Joins must not duplicate amounts: identities cannot
prove the author's accounting logic. A later `updateRecord` step may mark
`sepa-created`, but this means file creation, not payment; it is not part of the
same transaction as issuance. Claims remain the duplicate-export protection if
that later status update fails.

Multiple output steps are not one atomic batch. A SEPA file may already exist
when a later DATEV or PDF step fails. Inspect the existing run and Documents
before recovery; do not launch a fresh whole batch blindly. Each financial
output has its own reviewed receipt and confirmation. Reuse completed files;
use the actual failed run state to decide which remaining work is still needed.

## E-invoices, corrections, and self-billing

`de.zugferd.en16931@1` renders German outgoing EUR invoices as PDF/A-3b with embedded
Factur-X XML and a separate XML artifact. Version 2 additionally supports credit
notes and self-billing. Choose the exact installed version explicitly; editing a
template does not upgrade old Documents or retries.

Both versions require the following JSON input (unknown properties rejected):

- `invoiceDate`, `dueDate`: valid ISO dates; due date not before invoice date.
- `currency: "EUR"`.
- `seller`, `buyer`: each `{name, vatId, address}`. `name` 1–200; `vatId` exactly
  `DE` plus nine digits. Address `{line1, city, postalCode, countryCode: "DE"}`;
  maxima 200/100/20 for the text properties.
- `buyerReference`: 1–100 characters.
- `payment: {iban, accountName}`: electronic checksum-valid IBAN; account name
  1–200 characters.
- `lines`: 1–1,000 objects `{name, quantity, unitPrice, taxRate}`. Name 1–200;
  quantity positive with exactly four decimal places, unit price nonnegative with
  exactly four, tax rate greater than zero and at most 100 with exactly two.
  All numeric inputs are decimal strings, e.g. `"1.0000"`, `"19.9900"`, `"19.00"`.

Version 2 additionally accepts two optional properties per line:
`description` (1–4,000 characters) and `unitCode` (`C62` for units, `HUR` for
hours, `DAY` for days, or `KGM` for kilograms; default `C62`). Version 1 does
not accept these properties.

Version 2 also requires `serviceDate` and one `billing` variant:

```json
{"kind":"invoice"}
```

```json
{"kind":"creditNote","original":{"number":"INV-2026-42","invoiceDate":"2026-09-01"},"reason":"Returned item"}
```

```json
{"kind":"selfBilling","agreementReference":"Commission agreement 2026"}
```

The original invoice date must not follow the credit-note invoice date. Version 2
requires distinct seller/buyer VAT IDs. Quantities/amounts remain positive;
document kind expresses the credit. Seller always remains the supplier and buyer
the customer, including customer-issued self-billing. Payment identifies the
intended recipient explicitly.

These profiles use exact decimal arithmetic and half-up monetary rounding and
retain their calculated `output.currency`, `netAmount`, `taxAmount`, `grossAmount`,
`taxGroups`. Export those saved totals from issued Documents, not newly recomputed
live invoices. A renderer does not verify the original invoice exists, remaining
credit/commission balances, approval rules, or concurrent settlement. Those checks
belong to the issuing workflow. The supported scope excludes foreign currencies,
tax exemptions, allowances/charges, prepayments, cash discounts, and filing.

## Limits and recovery

| Boundary | Limit |
| --- | ---: |
| Template GQL | 20,000 |
| HTML body or profile input template | 200,000 |
| Header/footer/CSS | 50,000 each |
| Number/filename pattern | 5,000 each |
| Rendered template output | 300,000 bytes |
| Document query | 10,000 rows |
| Workflow capture including metadata | 5 MiB; also cumulative per run |
| Root-record images exposed to Liquid | 12, up to 2 MB each |
| Recursive record snapshot | 4 relation levels, 500 records |

Input schemas bound string lengths and rendering additionally enforces UTF-8 byte
limits; non-ASCII content can hit byte ceilings before the character count.
Limits fail explicitly rather than silently truncating an export.

- Invalid GQL: inspect preview `source` after Liquid substitution; use multiline
  clauses. Missing data: inspect preview `data`, permissions, aliases, and filters.
- Invalid Liquid: check roots/tags/filters and nullable images/fields; preview the
  complete profile input before enabling it.
- Schema/source change or stale financial guard: start a new capture and review
  it; never silently confirm a replacement hash.
- Uncertain generation outcome: first inspect runs/Documents, then retry the same
  idempotent attempt. New keys mean new business output, not harmless retries.
- Disabled/deleted template: existing authorized downloads and link management
  remain available; generation is a separate permission/lifecycle decision.

For detailed UI help, load **Documents & PDFs**, **Workflows**, **Evidence exports**,
and **Retention and preservation** through the Cloud help tools. This reference
covers operational inputs; it does not certify tax, bank, or legal compliance.
