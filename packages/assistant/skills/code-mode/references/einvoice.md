# Electronic invoices

`einvoice` is a global. These methods return Results: inspect `ok`, then use
`data` or `error: {code,status,message,issues}`. Issue entries contain
`{code,path,message,line?,column?}`; paths have zero-based row indices.

| Call | Successful `data` |
| --- | --- |
| `einvoice.validate(input)` | `Invoice` |
| `einvoice.calculate(lines)` | `InvoiceCalculation` |
| `einvoice.serialize(invoice, {format: "zugferd-2.5-en16931"})` | `{format, xml: string, bytes: Uint8Array}` |
| `einvoice.parseXml(xml, options?)` | `ParsedInvoice` |
| `await einvoice.parsePdf(bytes, options?)` | `ParsedInvoice` |
| `einvoice.parseXml(xml, {mode: "incoming"})` | `ParsedIncomingInvoice` |
| `await einvoice.parsePdf(bytes, {mode: "incoming"})` | `ParsedIncomingInvoice` |

All calls except `parsePdf` are synchronous. `parsePdf` takes a `Uint8Array`,
for example `new Uint8Array(await file.arrayBuffer())`. It reads embedded XML,
not scanned pages or arbitrary visual invoice layouts. For those, use the
[local PDF text reader](documents.md) or the agent's document/vision tools.

The supported slice covers EUR CII EN16931 invoices, credit notes and self-billing,
VAT categories S/Z/E/AE/K/G/O, units C62/HUR/DAY/KGM. Generation does not
support UBL, XRechnung, discounts or prepayments. Readers preserve declared totals;
parsing is not arithmetic verification. Validation is not XSD or Schematron
certification. No XSD validator is exposed.

## Complete input and result shapes

Type descriptions only; no imports are needed. All fields are required unless
marked `?`; unknown fields are rejected.

```ts
type Party = {
  name: string; id?: string; vatId: string; // "" when the party has no VAT ID
  address: {line1: string; city: string; postalCode: string; countryCode: string};
};
type Tax = {
  taxCategory?: "S" | "Z" | "E" | "AE" | "K" | "G" | "O"; // default "S"
  taxRate: string; taxExemptionReason?: string; taxExemptionReasonCode?: string;
};
type InvoiceLine = Tax & {
  id: string; name: string; description?: string;
  quantity: string; unitPrice: string; unitCode: "C62" | "HUR" | "DAY" | "KGM";
  netAmount?: string;
};
type InvoiceTotals = {
  netAmount: string; taxAmount: string; grossAmount: string; dueAmount: string;
  taxGroups: (Tax & {netAmount: string; taxAmount: string})[];
};
type Invoice = {
  kind: "invoice" | "creditNote" | "selfBilling";
  number: string; invoiceDate: string; serviceDate: string; dueDate: string;
  currency: "EUR"; seller: Party & {taxRegistrationId?: string}; buyer: Party;
  deliverToCountryCode?: string; buyerReference: string;
  notes?: string[];
  precedingInvoice?: {number: string; invoiceDate: string};
  payment: {iban: string; accountName: string};
  lines: InvoiceLine[]; totals?: InvoiceTotals;
};
type InvoiceCalculation = InvoiceTotals & {
  lines: (InvoiceLine & {netAmount: string})[];
};
type ParsedInvoice = {
  format: "zugferd-2.5-en16931"; profile: string; xml: string;
  invoice: Invoice; filename?: string;
};
type ParseOptions = {maxCharacters?: number; maxElements?: number; maxDepth?: number};
type PdfOptions = ParseOptions & {maxPdfBytes?: number};
```

XML options default to 10 Mi UTF-16 code units, 100,000 elements, depth 64.
PDF input defaults to 25 MiB. Overrides must be positive safe integers.
A parser result's business fields are under **`data.invoice`**. Calculated
amounts are directly under **`data.netAmount`**, etc., with no `data.totals` wrapper.

- Dates are real `YYYY-MM-DD` dates; `dueDate` cannot precede `invoiceDate`.
  Credit notes require `precedingInvoice`, whose date cannot be later than the
  credit note; other kinds cannot supply it. Credit-note amounts stay unsigned.
- Lines: 1–1000, unique IDs. Quantities are positive, prices nonnegative,
  VAT rates at most 100. Decimal strings allow up to four
  fractional digits and no leading zeros. Totals/net amounts require exactly
  two fractional digits; do not convert through JavaScript Number.
- Country codes: two uppercase letters. `payment.iban` must be valid.
  Required text is nonblank valid XML text. Limits: number/reference/line ID/VAT ID
  100; names/address line/accountName 200; city 100; postalCode 20;
  line description and each note 4000; at most 100 notes.
- Category S needs a positive rate; every other category uses `taxRate: "0"`
  and zero tax. E/AE/K/G/O need `taxExemptionReason` or a VATEX
  `taxExemptionReasonCode`; S/Z forbid both. O cannot be mixed with other
  categories and requires `vatId: ""` for both parties. A seller without a VAT
  ID needs `seller.id` and, outside O, `seller.taxRegistrationId`. AE/K need a
  buyer VAT ID, K/G a seller VAT ID, and K `deliverToCountryCode`.
- `calculate` rounds each line half up to cents, then VAT per category and rate. It recalculates
  line `netAmount`; `serialize` also rejects supplied line/totals values that
  disagree. Render these calculated amounts in HTML instead of another arithmetic path.

## Minimal supported invoice

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

Never infer a missing VAT identifier, tax category, exemption reason, account
or business reference merely to satisfy input validation.

## Reading received invoices

`{mode: "incoming"}` (plus the same limits) reads a broader separate model:
also XRechnung 3.0/2.3 CII, other currencies, discounts, prepayments, all
payment means and optional references. `data` is
`{format: "cii-en16931", profile, xml, invoice, unmapped, filename?}`.
Amounts are declared strings, never recalculated; O lines have no `taxRate`.
`unmapped` lists supplementary XML elements and attributes with their paths; review it before
accounting. Do not pass this `invoice` to `validate` or `serialize`.

For an invoice PDF, pass `serialized.data.xml` to
[`pdf.facturX`](pdf.md) with profile `"EN 16931"` and matching HTML.
Numbering, business mapping, issuance and persistence belong to the app.
