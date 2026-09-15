# DATEV and SEPA exports

`datev` and `sepa` are bundled globals from `@k2b/stdlib/finance`. No imports,
package installation, network, or WASM are needed. Both expose `validate(input)`
and `serialize(batch)`, returning `{ok:true,data}` or `{ok:false,error}`.
Errors contain `code`, `message`, and `issues` with field paths (row indices are
zero-based). Serialization also validates inputs. Use the returned `bytes`
unchanged with `files.save(new Blob([bytes]), filename)`, then `code_export` in agent runs.

DATEV supports `datev-700-13`: EUR bookings, S/H direction, UTF-8 BOM CSV with
CRLF, 31 header fields and 125 columns. SEPA supports ordinary EUR SCT transfers
in `sepa-sct-pain.001.001.09-gbic-5`, not direct debits or instant payments.
There is no full XSD validator. Input checks do not guarantee bank acceptance.
Generating a file does not send it to a bank or execute a payment.

Amounts are positive exact strings such as "12.30", never floats. DATEV maximum
is "9999999999.99"; SEPA maximum is "999999999.99". Totals are decimal strings.
Supply real business identifiers, accounts, tax keys and dates from the user
or authoritative data; do not infer them. `createdAt` is UTC with milliseconds.
SEPA message/payment IDs are supplied by the caller; end-to-end IDs must be
unique within a file. Exporting again is not a durable duplicate-payment guard.

The examples below use illustrative accounts and identifiers, not real payments.

```js
const datevExample = {
  format: "datev-700-13", currency: "EUR", createdAt: "2026-09-11T12:34:56.789Z",
  applicationInformation: "Example", consultantNumber: "29098", clientNumber: "55003",
  fiscalYearStart: "2026-01-01", accountLength: 4,
  periodStart: "2026-09-01", periodEnd: "2026-09-30", label: "September 2026", finalize: false,
  rows: [
    { amount: "123.45", direction: "S", account: "00440", counterAccount: "70000",
      documentDate: "2026-09-11", documentNumber: "RE-2026-1", text: 'Office; "rent"', taxKey: "0009" },
    { amount: "3.00", direction: "H", account: "00440", counterAccount: "70000",
      documentDate: "2026-09-12", documentNumber: "GS-2026-1", text: "Credit" },
  ],
};

const sepaExample = {
  format: "sepa-sct-pain.001.001.09-gbic-5", currency: "EUR", createdAt: "2026-09-11T12:34:56.000Z",
  messageId: "example-batch-1", paymentInformationId: "example-payment-1",
  debtorName: "Example & Partners", debtorIban: "DE89370400440532013000", executionDate: "2026-09-14",
  rows: [
    { endToEndId: "example-transfer-1", amount: "12.30", creditorName: "Recipient <Example>",
      creditorIban: "NL91ABNA0417164300", remittance: 'Example "train" & meal' },
    { endToEndId: "example-transfer-2", amount: "0.01", creditorName: "Second recipient",
      creditorIban: "NL91ABNA0417164300", creditorBic: "ABNANL2A", remittance: "Example adjustment" },
  ],
};


export default async () => {
  const csv = datev.serialize(datevExample);
  const xml = sepa.serialize(sepaExample);
  if (!csv.ok) throw new Error(JSON.stringify(csv.error));
  if (!xml.ok) throw new Error(JSON.stringify(xml.error));
  await files.save(new Blob([csv.data.bytes], {type:"text/csv"}), "buchungen.csv");
  await files.save(new Blob([xml.data.bytes], {type:"application/xml"}), "ueberweisungen.xml");
  return { bookings: csv.data.rowCount, debit: csv.data.debitTotal,
    credit: csv.data.creditTotal, transfers: xml.data.rowCount, total: xml.data.total };
};
```

DATEV optional posting fields: `text`, `taxKey` (four digits), `costCenter1`,
`costCenter2`. Optional header `applicationInformation` identifies the producer.
SEPA optional fields: `debtorBic` and per-row `creditorBic`. All names and
remittance text are escaped by the serializer; do not build CSV/XML yourself.

## Account reports: camt.052

`camt.parse(xml, limits?)` reads only `camt.052.001.08`. It returns a Result:

```js
const parsed = camt.parse(await file.text());
if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
const reports = parsed.data.reports;
```

The hierarchy is document → reports → entries → detail groups → transactions.
Amounts remain exact decimal strings with currency and separate CRDT/DBIT
indicators. Do not add entry totals and their transaction details together.
Missing details remain absent. Parsing does not reconcile, deduplicate, infer
payment completion, fetch missing pages, or read camt.053/other versions.
Defaults: 10 Mi UTF-16 code units, 250,000 elements, depth 64. Override via
`maxCharacters`, `maxElements`, `maxDepth` when a smaller budget is appropriate.

## Electronic invoices

Studio provides these pure-JavaScript stdlib 0.24 APIs directly:

- `einvoice.validate(unknown)` checks the supported model.
- `einvoice.calculate(lines)` calculates exact line, tax and invoice totals.
- `einvoice.serialize(invoice, { format: "zugferd-2.5-en16931" })` returns XML
  and UTF-8 bytes, checking supplied totals against its calculations.
- `einvoice.parseXml(xml, options?)` reads supported incoming CII XML.
- `await einvoice.parsePdf(bytes, options?)` extracts embedded invoice XML and
  parses it. Pass a `Uint8Array`; PDF input defaults to 25 MiB (`maxPdfBytes`).

All return Results; inspect `ok`, then use `data` or the structured `error`.
Readers preserve declared totals rather than certifying their arithmetic.
Keep decimal strings; never round through JavaScript Number. The supported
slice covers EUR CII EN16931 invoices, credit notes with an original invoice
reference, and self-billing; category S VAT, units C62/HUR/DAY/KGM. It does not
support UBL, XRechnung, discounts, prepayments or exemptions.

PDF reading uses bundled pure-JavaScript pdf-lib, not WASM. It reads embedded
XML, not scanned pages or arbitrary visual invoice layouts. Use PDF.js text
extraction or the agent's document/vision tools for those. No
`@k2b/stdlib/finance/validate` XSD/WASM checker is exposed. Model validation is
not XSD or Schematron certification.

Use [PDF generation](pdf.md) to combine generated XML with an HTML invoice.
Numbering, business mapping, authorization, issuance and persistence belong to
the app. For bank reconciliation, combine explicit file selection, CAMT parsing,
invoice parsing, exact `money` calculations and a manual confirmation for
ambiguous matches. Never treat a suggested match as proof of payment.


### Minimal supported invoice

Use real business data and an app-owned invoice number. This illustrative
fixture demonstrates the required fields; it is not a document to issue.

```js
const invoice = {
  kind: "invoice",
  number: "EXAMPLE-42",
  invoiceDate: "2026-09-15",
  serviceDate: "2026-09-15",
  dueDate: "2026-09-30",
  currency: "EUR",
  seller: {
    name: "Example Seller", vatId: "DE123456789",
    address: { line1: "Street 1", city: "Ulm", postalCode: "89073", countryCode: "DE" },
  },
  buyer: {
    name: "Example Buyer", vatId: "DE987654321",
    address: { line1: "Street 2", city: "Berlin", postalCode: "10115", countryCode: "DE" },
  },
  buyerReference: "ORDER-42",
  payment: { iban: "DE89370400440532013000", accountName: "Example Seller" },
  lines: [{ id: "1", name: "Service", quantity: "2.0000", unitPrice: "50.0000", unitCode: "HUR", taxRate: "19.00" }],
};
const result = einvoice.serialize(invoice, { format: "zugferd-2.5-en16931" });
if (!result.ok) throw new Error(JSON.stringify(result.error));
await files.save(new Blob([result.data.bytes], { type: "application/xml" }), "invoice.xml");
```

Unit prices allow up to four decimal places. Lines round half up to cents;
VAT rounds per rate. `calculate(invoice.lines)` returns the calculated lines,
tax groups and totals. Supply calculated values to the HTML view rather than
implementing a second arithmetic path. Never infer a missing VAT identifier,
account or business reference merely to satisfy input validation.
