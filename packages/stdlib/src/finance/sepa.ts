import { SepaBatchSchema, SepaHeaderSchema, type SepaBatch, type SepaHeader } from "./sepa-contracts";
import { total, validate, type FinanceResult } from "./common";
import { ok } from "../result";

const namespace = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09";
export type SepaFile = { bytes: Uint8Array; rowCount: number; total: string };

// Input contracts reject invalid XML characters before reaching this function.
const escapeXmlValue = (value: string | number) => String(value).replace(/[&<>"']/g, char => {
  switch (char) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    default: return "&apos;";
  }
});

/** Validate inputs and serialize ordinary SCT synchronously, without loading an XSD engine. */
function serialize(input: SepaBatch): FinanceResult<SepaFile> {
  const checked = validate(SepaBatchSchema, input);
  if (!checked.ok) return checked;
  const batch = checked.data;
  const createdAt = batch.createdAt;
  const sum = total(batch.rows.map(row => row.amount));
  const element = (name: string, value: string | number) => `<${name}>${escapeXmlValue(value)}</${name}>`;
  const agent = (name: string, value?: string) =>
    `<${name}><FinInstnId>${value === undefined ? "<Othr><Id>NOTPROVIDED</Id></Othr>" : element("BICFI", value)}</FinInstnId></${name}>`;
  const rows = batch.rows
    .map(
      (row) =>
        `<CdtTrfTxInf><PmtId>${element("EndToEndId", row.endToEndId)}</PmtId>` +
        `<Amt><InstdAmt Ccy="EUR">${row.amount}</InstdAmt></Amt>` +
        (row.creditorBic === undefined ? "" : agent("CdtrAgt", row.creditorBic)) +
        `<Cdtr>${element("Nm", row.creditorName)}</Cdtr><CdtrAcct><Id>${element("IBAN", row.creditorIban)}</Id></CdtrAcct>` +
        `<RmtInf>${element("Ustrd", row.remittance)}</RmtInf></CdtTrfTxInf>`,
    )
    .join("");
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${namespace}"><CstmrCdtTrfInitn>` +
    `<GrpHdr>${element("MsgId", batch.messageId)}${element("CreDtTm", createdAt)}${element("NbOfTxs", batch.rows.length)}` +
    `${element("CtrlSum", sum)}<InitgPty>${element("Nm", batch.debtorName)}</InitgPty></GrpHdr>` +
    `<PmtInf>${element("PmtInfId", batch.paymentInformationId)}<PmtMtd>TRF</PmtMtd><BtchBookg>true</BtchBookg>` +
    `${element("NbOfTxs", batch.rows.length)}${element("CtrlSum", sum)}<PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>` +
    `<ReqdExctnDt>${element("Dt", batch.executionDate)}</ReqdExctnDt><Dbtr>${element("Nm", batch.debtorName)}</Dbtr>` +
    `<DbtrAcct><Id>${element("IBAN", batch.debtorIban)}</Id></DbtrAcct>${agent("DbtrAgt", batch.debtorBic)}` +
    `<ChrgBr>SLEV</ChrgBr>${rows}</PmtInf></CstmrCdtTrfInitn></Document>`;
  return ok({ bytes: new TextEncoder().encode(xml), rowCount: batch.rows.length, total: sum });
}

export const sepa = {
  validateHeader: (input: unknown): FinanceResult<SepaHeader> => validate(SepaHeaderSchema, input),
  validate: (input: unknown): FinanceResult<SepaBatch> => validate(SepaBatchSchema, input),
  serialize,
};
