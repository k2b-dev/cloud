# DATEV and SEPA exports

`datev` and `sepa` are globals. Calls are synchronous and local; no imports
or network access are needed. Both expose `validate(input)`
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
    { endToEndId: "example-transfer-1", amount: "12.30", creditorName: "Recipient (Example)",
      creditorIban: "NL91ABNA0417164300", remittance: "Example train & meal" },
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

## Contracts and validation

`datev.validate(input)` returns a Result containing the validated batch;
`datev.serialize(batch)` returns a Result containing
`{ bytes: Uint8Array, rowCount: number, debitTotal: string, creditTotal: string }`.
`sepa.validate(input)` returns the validated batch;
`sepa.serialize(batch)` returns
`{ bytes: Uint8Array, rowCount: number, total: string }` inside its Result.
Both batch shapes are demonstrated completely above: every field is required
except the explicitly listed optional fields. Unknown fields are rejected;
`rows` must be nonempty. Neither serializer returns a CSV/XML string.

All finance Results use this shape (also for `camt` and `einvoice`):

```ts
type Result<T> = { ok: true; data: T } | {
  ok: false;
  error: {
    code: "BAD_INPUT" | "INTERNAL";
    status: number;
    message: string;
    issues: { code: string; path: (string | number)[]; message: string;
              line?: number; column?: number }[];
  };
};
```

Issue codes are `unsupported_format`, `input_limit`, `invalid_input`,
`invalid_xml`, `schema_mismatch`, `schema_integrity`, `validator_unavailable`.
XML line/column positions are one-based when supplied.

DATEV constraints:
- Dates lie in 2000–2099; the posting period lies within the fiscal year and
  each document date within that period.
- `consultantNumber`: 4–7 digits, no leading zero, at least 1001;
  `clientNumber`: 1–5 digits, no leading zero; `accountLength`: integer 4–8.
- Accounts are 1–9 digits, not all zero, at most `accountLength + 1` characters.
- `documentNumber`: 1–36 characters from letters, digits, `_ $ & % * + - /`;
  `text`: at most 60; `applicationInformation`: at most 16.
- `label`: 1–30 Unicode letters/digits or `_ . - /` and spaces.
  Cost centers: at most 36 Unicode letters/digits, underscores or spaces.
  Control characters are rejected.

SEPA constraints:
- IDs: 1–35 ASCII letters/digits or `+ ? / : ( ) . , ' -` and spaces;
  no leading/trailing slash or `//`.
- Names: 1–70 characters; `remittance`: 1–140. Both use ASCII letters/digits,
  `+ ? / : ( ) . , ' -` and spaces, plus `ÄÖÜäöüß&*$%`. Blank values,
  double quotes, angle brackets, other accented letters, emoji, and control
  characters are rejected; text is not transliterated.
- IBANs must be valid uppercase SEPA IBANs without spaces; QR-IBANs are rejected.
  Optional BICs must be valid BICs.

For statement imports read [CAMT](camt.md); for incoming/outgoing electronic
invoices read [Electronic invoices](einvoice.md). Use [Money](money.md) for
calculations and [PDF generation](pdf.md) for invoice PDFs.
