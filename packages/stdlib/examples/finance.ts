import { datev, sepa, type DatevBatch, type SepaBatch } from "../src/finance";

export const datevExample: DatevBatch = {
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

export const sepaExample: SepaBatch = {
  format: "sepa-sct-pain.001.001.09-gbic-5", currency: "EUR", createdAt: "2026-09-11T12:34:56.000Z",
  messageId: "example-batch-1", paymentInformationId: "example-payment-1",
  debtorName: "Example & Partners", debtorIban: "DE89370400440532013000", executionDate: "2026-09-14",
  rows: [
    { endToEndId: "example-transfer-1", amount: "12.30", creditorName: "Recipient (Example)",
      creditorIban: "NL91ABNA0417164300", remittance: "Example 'train' & meal" },
    { endToEndId: "example-transfer-2", amount: "0.01", creditorName: "Second recipient",
      creditorIban: "NL91ABNA0417164300", creditorBic: "ABNANL2A", remittance: "Example adjustment" },
  ],
};

/** Sample identifiers/accounts illustrate syntax only; do not submit these files. */
export function financeExample() {
  const csv = datev.serialize(datevExample);
  const xml = sepa.serialize(sepaExample);
  if (!csv.ok) throw new Error(JSON.stringify(csv.error));
  if (!xml.ok) throw new Error(JSON.stringify(xml.error));
  return {
    datevRows: csv.data.rowCount, debitTotal: csv.data.debitTotal, creditTotal: csv.data.creditTotal,
    sepaRows: xml.data.rowCount, total: xml.data.total,
  };
}

/** Workflow configuration can be checked before real execution metadata exists. */
export function validateFinanceHeaders() {
  const { rows: datevRows, createdAt: datevCreatedAt, ...datevHeader } = datevExample;
  const { rows: sepaRows, createdAt: sepaCreatedAt, messageId, paymentInformationId, ...sepaHeader } = sepaExample;
  return { datev: datev.validateHeader(datevHeader), sepa: sepa.validateHeader(sepaHeader) };
}
