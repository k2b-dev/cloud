import Decimal from "decimal.js";
import { ParseOption, XmlDocument, XsdValidator } from "libxml2-wasm";
import type { z } from "zod";
import { canonicalDocumentJson } from "../service/document-json";
import { escapeXmlValue } from "../service/document-xml";

export const SEPA_SCHEMA_SHA256 = "35cfe972a636392704fd930c3e0496fc05b95ff891deb635b168dcdabf3c08a3";
const namespace = "urn:iso:std:iso:20022:tech:xsd:pain.001.001.09";

import { SepaBatchSchema } from "./sepa-xml-contracts";

/** No external input providers, DTDs, schema URLs or global libxml configuration. */
export const validateSepaXml = async (xml: string): Promise<void> => {
  if (xml.includes("<!")) throw new Error("SEPA XML must not contain a DTD or CDATA.");
  const schema = await Bun.file(new URL("./schema/pain.001.001.09_GBIC_5.xsd", import.meta.url)).text();
  if (new Bun.CryptoHasher("sha256").update(schema).digest("hex") !== SEPA_SCHEMA_SHA256)
    throw new Error("The pinned SEPA schema has changed.");
  const options = { option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_NO_SYS_CATALOG };
  const schemaDocument = XmlDocument.fromString(schema, options);
  let validator: XsdValidator | undefined;
  let document: XmlDocument | undefined;
  try {
    validator = XsdValidator.fromDoc(schemaDocument);
    document = XmlDocument.fromString(xml, options);
    validator.validate(document);
  } finally {
    document?.dispose();
    validator?.dispose();
    schemaDocument.dispose();
  }
};

/** Pure format layer: callers persist identifiers before rendering and own confirmation/reservation. */
export const renderSepaBatch = async (input: z.input<typeof SepaBatchSchema>, issuedAt: Date) => {
  const batch = SepaBatchSchema.parse(input);
  canonicalDocumentJson(batch);
  const createdAt = issuedAt.toISOString();
  const sum = batch.rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2);
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
  await validateSepaXml(xml);
  return { bytes: new TextEncoder().encode(xml), rowCount: batch.rows.length, total: sum, schemaSha256: SEPA_SCHEMA_SHA256 };
};
