# DATEV XML-Schnittstelle online (Belegtransfer)

Requires `@k2b/stdlib >= 0.30.0`; file-only `documentImage` requires >= 0.36.0.
Full contract: `docs/datev-xml.md`.

- `datevXml.validate(unknown)` and `datevXml.serialize(DatevXmlPackage)` from
  `@k2b/stdlib/finance`: synchronous, pure JS, no XSD engine. `serialize` returns
  `DatevXmlFile` with `bytes` (ZIP), `documentXml`, `lineCount`, and per document
  `dataFile`, `xml`, `amount` (exact signed sum) and `files`.
- `createDatevXmlPackage(input, { schemas })` from `@k2b/stdlib/finance/validate`:
  serialize plus XSD check of document.xml and every ledger file; returns bytes
  only when all pass. Use it for files given to DATEV. Needs `libxml2-wasm@0.6.0`.
- `validateDatevXml(xml, { schema: "document" | "ledger", schemas })` checks one file.
- The stdlib does not ship DATEV's XSDs. `schemas` maps the four file names to
  their text; get them from `datevXmlSchemaSource.url` (version 6.0), keep them
  privately, load on Bun with `loadDatevXmlSchemas(dir)` from `@k2b/stdlib/bun`.
  Missing file: `INTERNAL`/`validator_unavailable`; hash mismatch:
  `INTERNAL`/`schema_integrity` (`datevXmlSchemaSha256` per file).
- Package: `format: "datev-xml-online-6.0"`, `currency: "EUR"`, `createdAt` as
  local `YYYY-MM-DDTHH:mm:ss` (no offset), `generatorInfo` (sender name, 1–40),
  optional `generatingSystem`, `description`, `documents` (1–4999).
- Document `kind`: `accountsPayableLedger` / `accountsReceivableLedger`
  (`period`, `folder`, `documentDate`, `documentNumber`, `lines`, `files`, party
  and date fields) or `cashLedger` (`period`, `cashRegister: { accountNumber } |
  { name }`, `documentDate`, `lines` with required `text`, `files`).
- Amounts: `"-12.30"` strings, never `0.00`. Invoice lines share one sign
  (negative = correction); cash lines may mix (negative = expense).
- Text: DATEV repertoire only (ASCII, Latin-1 letters, `€`, CJK, Hangul), NFC, no
  edge spaces; `text` max 30. Nothing is cut or replaced; failures carry paths.
- File names: ASCII, unique case-insensitively, DATEV file types (no HEIC, WebP,
  ZIP), max 100 characters; `datev-ledger-<digits>.xml` and `document.xml` are
  reserved; bytes 1 B–20 MB, signatures checked for PDF and images.
- Callers map supplier invoice numbers to the invoiceId pattern, replace
  typographic characters, use a deterministic GUID per document and the month of
  the document date as period. Consignor credit notes are `accountsPayableLedger`.
- A passing check does not prove the client's DATEV settings (fiscal year,
  folder and cash register names, accounts, BU keys); test-import once.

## Images with separate monthly bookings (0.36.0)

Use `{ kind: "documentImage", guid, files }`, with no ledger fields. GUID is
required (hex 8-4-4-4-12, 36 characters, no braces, both cases preserved); files
must contain 1–49 attachments. Only File extensions appear in `document.xml`,
no generated `datev-ledger-*.xml`; XSD validation checks the administrative file.
Output `documents` retains input order; image entries contain only `files`.
Check `entry.dataFile !== undefined` before using `xml`/`amount`. Images add
zero to `lineCount`; existing ledger kinds and their bytes stay unchanged.

Reuse `guid` as each matching CSV row's `documentGuid` (see `finance.md`).
DATEV documents the exact CSV cell `"BEDI ""<GUID>"""`; this is not an assumption.
Both hex cases follow `p10037` in the [official XSDs](https://developer.datev.de/assets/XSD_3c866dbe96.zip),
but CSV case-insensitive lookup is not guaranteed; reuse identical spelling.
[DATEV's XML guide](https://developer.datev.de/de/file-formats/details/datev-xml-interface-online/getting-started)
explicitly supports pure archiving of images with GUID. Expected filing under
"Sonstige Belege" is an assumption to test: omitted `type` is called "ohne
Belegtyp" by the XSD; the client configuration and UI label are not proven here.
Check that images do not land in the inbox or receive separate booking proposals:
`Document_v060.xsd` warns of duplicate bookings when booking-relevant documents
also have booking data transferred separately. File-only default routing is
unspecified; confirm it during the test import.
**Release verification note:** Ein Testimport in DATEV ist hier nicht möglich; die Kanzlei muss einmal Testimport plus Beleglink prüfen.
