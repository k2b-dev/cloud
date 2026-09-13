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
