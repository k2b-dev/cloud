# DATEV XML-Schnittstelle online (Belegtransfer)

`datevXml` builds a ZIP for DATEV Belegtransfer: one `document.xml`, one ledger
data file per invoice/cash document, and the document images. File-only
`documentImage` documents need no ledger file. DATEV imports it into
Unternehmen online: invoices into the invoice books (Rechnungseingang,
Rechnungsausgang), cash movements into Kassenbuch online. The library does not
upload, store or track anything.

```sh
bun add @k2b/stdlib zod@^4.4.3 ibantools@^4.5.4 saxes@^6.0.0
# For the XSD check (recommended):
bun add libxml2-wasm@0.6.0
```

## Public contract

```ts
import { datevXml, datevXmlLimits } from "@k2b/stdlib/finance";
import type {
  DatevXmlPackage, DatevXmlDocument, DatevXmlAccountsPayable, DatevXmlAccountsReceivable,
  DatevXmlCash, DatevXmlDocumentImage, DatevXmlInvoiceLine, DatevXmlCashLine, DatevXmlAttachment,
  DatevXmlFile, DatevXmlFileDocument,
} from "@k2b/stdlib/finance";

datevXml.validate(input: unknown): FinanceResult<DatevXmlPackage>;
datevXml.serialize(input: DatevXmlPackage): FinanceResult<DatevXmlFile>; // sync, no XSD engine

import {
  createDatevXmlPackage, validateDatevXml, datevXmlSchemaSha256, datevXmlSchemaSource, type DatevXmlSchemas,
} from "@k2b/stdlib/finance/validate";
createDatevXmlPackage(input: DatevXmlPackage, options: { schemas: DatevXmlSchemas }): Promise<FinanceResult<DatevXmlFile>>;
validateDatevXml(xml: string, options: { schema: "document" | "ledger"; schemas: DatevXmlSchemas }): Promise<FinanceResult<void>>;

import { loadDatevXmlSchemas } from "@k2b/stdlib/bun";
loadDatevXmlSchemas(directory: string): Promise<DatevXmlSchemas>;
```

Use `createDatevXmlPackage` for files you hand to DATEV. It verifies DATEV's
schema files, serializes, checks `document.xml` and every ledger file against the
XSD and returns bytes only when all of them pass. DATEV recommends this check in the sending software.
`serialize` is the same build without the WASM engine, for previews and tests.
Treat a failed check, including `validator_unavailable`, as a failure.

Errors follow the other finance formats: `BAD_INPUT` with `issues` carrying
`code`, `path` (zero-based indices, for example
`["documents", 3, "lines", 0, "amount"]`) and a message. XSD issues use
`["xml", "<file name in the ZIP>"]` with one-based `line` and `column`. Nothing
is shortened, replaced or converted: a value DATEV would reject or silently cut
fails with its path.

## DATEV's schema files

The stdlib does not ship DATEV's XSDs. Download them once and keep them in your
private repository or image:

- Source: DATEV Developer Portal, XML-Schnittstelle online, section "XSD-Files",
  version 6.0: <https://developer.datev.de/assets/XSD_3c866dbe96.zip>
  (archive SHA-256 `0b25a3e512a262c93142d977b88bc04d1169e1495ebf72069cb074d6c4c42cb0`).
- Required files and their pinned SHA-256 (`datevXmlSchemaSha256`; the archive's
  invoice XSDs are not needed):

| File | SHA-256 |
|---|---|
| `Document_v060.xsd` | `11759fba36a156719e7cc3c1e19708aa0ea885e9093b6bdbb6a495c40bff362a` |
| `Document_types_v060.xsd` | `78ee3cb0f05aa93652347cd5693184b16ab52985b83e1270234448db68327022` |
| `Belegverwaltung_online_ledger_import_v060.xsd` | `b2807c9ef14c87dea214bda5c3b2cf2de8333511897eb51dbf19b526409f62be` |
| `Belegverwaltung_online_ledger_types_v060.xsd` | `a2bc696b0dbf18b49943001a06e6268f0480aaaa8bf272964972b524ec2542a3` |

Pass them as `schemas`: a map from file name to the file's text, unchanged
(UTF-8, CRLF line endings). On Bun, `loadDatevXmlSchemas(directory)` reads the
four files. Every call verifies all four hashes first:

- a missing file returns `INTERNAL` with `validator_unavailable`, naming the file
  and the source URL,
- a changed file (including converted line endings) returns `INTERNAL` with
  `schema_integrity`.

There is no check without schemas and no silent skip. `datevXmlSchemaSource`
exports the URL, version and archive hash for setup scripts.

## Example

```ts
import { createDatevXmlPackage } from "@k2b/stdlib/finance/validate";
import { loadDatevXmlSchemas } from "@k2b/stdlib/bun";

const schemas = await loadDatevXmlSchemas("./datev-xsd"); // DATEV's files, kept privately
const result = await createDatevXmlPackage({
  format: "datev-xml-online-6.0",
  currency: "EUR",
  createdAt: "2026-11-02T09:15:00",      // local time, no offset (XSD rule)
  generatorInfo: "Muster GmbH",          // shown as sender in the invoice lists
  generatingSystem: "Example Software",  // optional
  documents: [
    {
      kind: "accountsPayableLedger",     // Rechnungseingang
      guid: "0f8fad5b-d9cb-469f-a165-70867728950e", // optional; DATEV skips a known GUID
      period: "2026-10",
      folder: "Eingangsrechnungen",      // folder name in Belege online
      documentDate: "2026-10-14",
      documentNumber: "R-2026-0815",
      dueDate: "2026-10-28",
      partyName: "Bürobedarf Müller & Söhne",
      lines: [
        { amount: "119.00", taxRate: "19.00", costCenter1: "100", text: "Büromaterial 19 %" },
        { amount: "10.70", taxRate: "7.00", costCenter1: "100", text: "Fachbuch 7 %" },
      ],
      files: [{ name: "ER-R-2026-0815.pdf", bytes: pdfBytes }],
    },
    {
      kind: "cashLedger",                // Kassenbuch online
      period: "2026-10",
      cashRegister: { name: "Kasse" },   // or { accountNumber: "1000" }
      documentDate: "2026-10-21",
      lines: [{ amount: "-23.80", taxRate: "19.00", text: "Porto", documentNumber: "KB-0042" }],
      files: [{ name: "KB-0042.pdf", bytes: receiptBytes }],
    },
  ],
}, { schemas });
if (!result.ok) throw new Error(JSON.stringify(result.error.issues));
await save("DATEV-2026-10.zip", result.data.bytes); // application function
```

`DatevXmlFile` contains `bytes` (the ZIP), `documentXml`, `lineCount` and per
ledger document the generated `dataFile` name, its `xml`, the exact signed `amount`
(`consolidatedAmount`) and the attached file names. File-only documents return
only `files`; guard `document.dataFile !== undefined` before reading ledger
metadata (`dataFile`, `xml`, `amount`). This output union is new in 0.36.0. See the runnable
[example](../examples/datev-xml.ts).

## Transfer images and link monthly bookings

Since 0.36.0, use `kind: "documentImage"` to transfer images while the monthly
bookings come separately as an EXTF batch:

```ts
const guid = "E0A08953-FBAA-4054-AF36-993D5D68F040"; // persist and reuse this ID
const result = await createDatevXmlPackage({
  format: "datev-xml-online-6.0", currency: "EUR",
  createdAt: "2026-11-02T09:15:00", generatorInfo: "Muster GmbH",
  documents: [{
    kind: "documentImage", guid,
    files: [{ name: "RE2026-00012.pdf", bytes: receiptBytes }],
  }],
}, { schemas });
// In the separate datev.serialize batch, set each matching row's documentGuid: guid.
```

This package contains `document.xml` and the image files. Each document has
`guid` and only `extension xsi:type="File"` elements: no ledger extension,
`datev-ledger-*.xml`, lines, amount, period, folder or document date. The shared
package fields still apply. Images contribute zero to `lineCount`; `documents`
retains one entry per input document, in input order, with only `files` for an
image. Mixed image and ledger packages are supported; ledger file numbering
continues to use the input document index. File-only documents use the existing
supported limit of 49 files (the XSD permits up to 50 extensions).

Use the same 36-character GUID (hexadecimal 8-4-4-4-12, without braces) in
`guid` and the booking row's `documentGuid`. Both cases pass DATEV's XSD and
are preserved; duplicate GUIDs within a package are rejected without regard to
case. Missing GUIDs and empty image file lists fail input validation. Existing
ledger kinds keep their optional GUID and byte-identical output.

Sources (checked 2026-11-19): DATEV's [XML getting started](https://developer.datev.de/de/file-formats/details/datev-xml-interface-online/getting-started)
explicitly lists images with GUID for pure archiving and document linking.
The [administrative data file](https://developer.datev.de/de/file-formats/details/datev-xml-interface-online/format-specification/administrative-data-file)
and [official XSD archive](https://developer.datev.de/assets/XSD_3c866dbe96.zip)
permit File-only documents; `Document_types_v060.xsd` type `p10037` specifies
the GUID pattern. `createDatevXmlPackage` validates the administrative XML
against those pinned XSDs; there is no generated ledger XML to validate.

**Assumption to confirm with the accounting firm:** the desired destination is
"Sonstige Belege". The XSD describes omitted `document@type` as "ohne Belegtyp";
it does not guarantee that UI label or the client's filing configuration.
The library omits `type`, `processID` and `repository`. During the test import,
check that the image is filed for archiving, does not land in the inbox and
receives no separate booking proposal. The `processID` annotation in
`Document_v060.xsd` warns that booking-relevant inbox documents can lead to
duplicate bookings when booking information also arrives through another path.
The default destination of File-only documents is not specified there; confirm
this client's behavior before the monthly EXTF import.
The [CSV cell format](./finance.md#link-a-posting-to-its-document-image)
is explicitly documented by DATEV; case-insensitive lookup across differing
GUID spellings has not been verified and is not relied on.

**Release verification note:** Ein Testimport in DATEV ist hier nicht möglich; die Kanzlei muss einmal Testimport plus Beleglink prüfen.

The [combined runnable example](../examples/datev-beleglink.ts) produces a
checked image ZIP and an EXTF batch with the same GUID. Import the images before
checking the links in the monthly booking batch.

## Documents and fields

A ledger document is one invoice or one cash day (or a single cash movement). It
becomes one ledger file; its lines become DATEV Belegsätze. Values on
the document are repeated on every line and form the `consolidate` attributes,
so they always agree.

| Kind | DATEV | Required | Optional |
|---|---|---|---|
| `accountsPayableLedger` | Rechnungseingang | `period`, `folder`, `documentDate`, `documentNumber`, `lines`, `files` | `guid`, `deliveryDate`, `dueDate`, `paidAt`, `partyId`, `partyAccount`, `partyName`, `partyCity`, `vatId`, `iban`, `bic` |
| `accountsReceivableLedger` | Rechnungsausgang | same | same |
| `cashLedger` | Kassenbuch online | `period`, `cashRegister`, `documentDate`, `lines`, `files` | `guid` |
| `documentImage` (since 0.36.0) | Pure archiving; expected "Sonstige Belege" (see below) | `guid`, `files` (at least one) | none |

`files` is required. Ledger documents may use an empty array `[]` when no GUID
is supplied; `documentImage` requires a GUID and at least one file.

Line fields: `amount` (required), `taxRate`, `account`, `buCode`,
`costCenter1`, `costCenter2`, `information`, `text` (required for cash), and for
cash also `documentNumber`.

| Field | DATEV element | Rule |
|---|---|---|
| `period` | property key 1 | `YYYY-MM`; contains `documentDate` |
| `folder` | property key 3 | 1–40 characters |
| `cashRegister.accountNumber` / `.name` | property key 2 / key 3 | exactly one; 1–9 digits / 1–40 characters |
| `guid` | `document@guid` | GUID; needs at least one file; unique in the package |
| `documentDate` | `date`, `consolidatedDate` | 2000–2099 |
| `documentNumber` | `invoiceId`, `consolidatedInvoiceId` | 1–36 of `A–Z a–z 0–9 $ % & * + - /` (no `_`, `.`, space) |
| `amount` | `amount`, `consolidatedAmount` | `"-12.30"` style; never `0.00`; up to ±9999999999.99, also as sum |
| `taxRate` | `tax` | `"0.00"`–`"99.99"` |
| `account` | `accountNo` (Gegenkonto) | 1–9 digits, no leading zero |
| `buCode` | `buCode` | 1–4 digits, no leading zero |
| `costCenter1`, `costCenter2` | `costCategoryId`, `costCategoryId2` | 1–36 characters |
| `text` | `bookingText` | 1–30 characters |
| `information` | `information` | 1–120 characters |
| `partyId` | `partyId` | 1–15 characters |
| `partyAccount` | `bpAccountNo` | 5–9 digits; creditor (first digit 7–9) for incoming, debtor (first digit 1–6) for outgoing invoices |
| `partyName`, `partyCity` | `supplierName`/`customerName`, `supplierCity`/`customerCity` | 1–50 / 1–30 characters |
| `vatId`, `iban`, `bic` | `vatId`, `iban`, `swiftCode` | uppercase, no spaces; IBAN checksum checked |
| `deliveryDate`, `dueDate`, `paidAt` | same names | `deliveryDate ≤ documentDate ≤ dueDate` |

Package fields: `format: "datev-xml-online-6.0"`, `currency: "EUR"`,
`createdAt`, `generatorInfo` (1–40), optional `generatingSystem` (1–40) and
`description` (1–255).

### Signs

- Invoices: positive lines are an invoice, negative lines a correction
  (Rechnungskorrektur, credit). All lines of one invoice must have the same sign.
  This rule is a conservative reading and not confirmed by a DATEV test import;
  it can be relaxed if a test import accepts mixed signs.
- Cash: positive is an income (Einnahme), negative an expense (Ausgabe). Lines
  may mix signs; their sum may be `0.00`.
- DATEV rejects `0.00` on a line. Leave such lines out.

### Text

DATEV accepts UTF-8 restricted to ASCII letters and digits, space, these characters

```text
§ @ € # | ` ´ ' ^ ° % & " * ~ : ; . - / + = _ ? $ ! { } [ ] , ( ) < > \
```

and Latin-1 letters (U+00A0–U+00FF, for example `ä ö ü ß é`), CJK and Hangul,
in precomposed form (NFC). Text outside this set fails, for example `„ “ – …`,
`Ł`, `Œ`, emoji, tabs and line breaks. Decomposed text fails with a hint to call
`normalize("NFC")`. Leading or trailing spaces and blank values fail.

### Files

- Names: ASCII letters, digits, `.`, `_`, `-`, at most 100 characters, starting
  with a letter or digit, ending in a DATEV file type (`pdf xml tif tiff bmp csv
  doc docx gif jpeg jpg ods odt png rtf txt xls xlsx`). Use the document number,
  for example `RE2026-00012.pdf`. Names must be unique in the package without
  regard to case (Belegtransfer runs on Windows). Reserved: `document.xml`, every
  name of the form `datev-ledger-<digits>.xml` (for example
  `datev-ledger-0002.xml`, also in a package with one document) and Windows device
  names such as `CON.pdf`.
- DATEV does not process nested ZIPs, and `.zip` is no permitted file type. Office
  files (`docx`, `xlsx`, `odt`, `ods`) are ZIP containers internally but are
  permitted file types and are passed through as files.
- Bytes: 1 byte to 20 MB per file; PDF, PNG, JPEG, GIF, BMP and TIFF content
  must match the extension.
- Several files of one document are stapled together in Belege online.

### Limits

`datevXmlLimits` exports them: 4999 documents per package (XSD), 5000 lines per
document, 49 files per document, 20 MB per file and 465 MB per package (DATEV's
technical limit). DATEV recommends packages of about 100 MB; split larger months
yourself. The ZIP is built in memory: peak memory is about twice the package size
(the input files plus the finished ZIP), so a 465 MB package needs around 1 GB.
Split at about 100 MB.

## Output

- ZIP: stored entries (no compression; PDFs are already compressed), ASCII names,
  MS-DOS timestamp from `createdAt`, order `document.xml`, then per document its
  ledger file and files. No nested ZIPs, no ZIP64.
- XML: UTF-8 without BOM, LF, `xsi:schemaLocation` as in DATEV's samples, element
  order exactly as in the XSD, values XML-escaped.
- Identical input produces identical bytes.

## Conservative decisions

Where the specification leaves room, the library chooses the stricter reading:

- `bookingText` at most 30 characters: the portal documents 30 characters for
  invoices, and Kassenbuch online cuts after 30 even though the XSD allows 60.
- No `processID`, document `type` or `repository`: DATEV's samples omit them and
  structured data must not go to the inbox (`processID=1`). DATEV then files the
  documents in its default folders ("IMPORT JJJJ RE", "IMPORT JJJJ Kasse").
- No `consultantNumber`, `clientNumber` or `clientName`: DATEV advises against them.
- EUR only, as for the other finance formats; Kassenbuch online accepts only EUR.
- Mixed signs within one invoice, a delivery date after the document date (DATEV
  ignores it), and C1 control characters fail instead of being passed on.
- File size limits are decimal (20 000 000 and 465 000 000 bytes).

Not supported: the older invoice format, SEPA collective payments, discounts and
payment terms, exchange rates, OSS fields, bank code/account number, order IDs,
internal invoice numbers and KOST quantities. Add them when a consumer needs them.

## What the checks do not prove

The XSD and these input rules catch technical errors only. DATEV's import also
checks the client's settings, which only a test import shows:

- the period lies in an existing fiscal year and is not finalized,
- the folder name and cash register (number or name) exist in Belege online and
  Kassenbuch online,
- account numbers fit the client's account length and chart of accounts, and BU
  keys are allowed in Unternehmen online,
- the GUID handling and the stapling of files behave as intended.

## Notes for callers

- **Invoice numbers:** `documentNumber` follows the XSD pattern (`A–Z a–z 0–9 $ % & * + - /`,
  at most 36). Supplier numbers often contain `_`, `.` or spaces. Define one mapping rule
  in your application (for example replace each with `-` and keep the original in
  `information`) and apply it before calling; the library does not map.
- **Typographic characters** such as `„ “ ‚ ‘ – — …` fail. Replace them in your
  application, for example with `" ' - ...`, or ask the user.
- **HEIC and WebP** are no DATEV file types. Convert phone photos to JPEG or PDF first.
- **GUID:** derive one deterministic GUID per document (a stored UUID or a UUIDv5
  of your document ID). DATEV skips a GUID it already knows, so a repeated upload
  does not create duplicates. A random GUID per export would.
- **Period:** use the month of the document date (`period: documentDate.slice(0, 7)`);
  DATEV books by document date, not by the day the document became final.
- **Credit notes to a consignor** (Gutschrift an einen Einlieferer, self-billing): the
  money flows to the consignor, so send it as `accountsPayableLedger` with positive
  amounts; a correction of it has negative amounts.

## Schema validation

Validation uses `libxml2-wasm@0.6.0` with network access, external entities and
system catalogs disabled, against the caller's schema files after their hashes
are verified. `validateDatevXml` rejects DTDs and CDATA before parsing; comments
are allowed because DATEV's own samples contain them. Compiled schemas are cached
per module and survive other libxml2 consumers resetting their input providers.
Bundling follows the [finance notes](./finance.md#offline-validation-and-runtime-requirements).

The repository's tests and CI download DATEV's archives from the pinned URLs into
the git-ignored `.cache/datev-xml/` (`bun run datev:fixtures`) and fail if a URL
or hash no longer matches.
