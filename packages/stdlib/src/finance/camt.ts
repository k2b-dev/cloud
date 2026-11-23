import { z } from "zod";
import { ok } from "../result";
import { invalid, type FinanceResult } from "./common";
import { CamtReadError, camtNamespace, readCamtXml } from "./camt-xml";
import type {
  CamtAccount, CamtAmount, CamtBankTransactionCode, CamtCode, CamtDate, CamtDirection,
  CamtDocument, CamtEntry, CamtEntryDetails, CamtParseOptions, CamtParty, CamtReport,
  CamtTransaction, CamtXmlElement,
} from "./camt-types";

type Element = CamtXmlElement;
const trimXmlWhitespace = (value: string) => value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");

function parse(xml: string, options?: CamtParseOptions): FinanceResult<CamtDocument> {
  try {
    const { document, locations } = readCamtXml(xml, options);
    const fail = (node: Element, message: string): never => {
      throw new CamtReadError({ code: "invalid_input", path: ["xml"], ...locations.get(node), message });
    };
    const children = (node: Element, name: string): Element[] => {
      const found = node.content.filter((child): child is Element => typeof child !== "string" && child.name === name);
      if (found.some(child => child.namespace !== camtNamespace)) fail(node, `Unexpected namespace for ${name}.`);
      return found;
    };
    const one = (node: Element, name: string): Element | undefined => {
      const found = children(node, name);
      if (found.length > 1) fail(node, `Duplicate ${name}.`);
      return found[0];
    };
    const required = (node: Element, name: string): Element => one(node, name) ?? fail(node, `Missing ${name}.`);
    const value = (node: Element): string => {
      if (node.content.some(child => typeof child !== "string")) fail(node, "Expected scalar text.");
      const result = node.content.join("");
      if (!result.length) fail(node, "Expected nonempty text.");
      return result;
    };
    const text = (node: Element, name: string): string | undefined => {
      const child = one(node, name); return child ? value(child) : undefined;
    };
    const reqText = (node: Element, name: string) => value(required(node, name));
    const optional = <T>(node: Element, name: string, read: (child: Element) => T): T | undefined => {
      const child = one(node, name); return child ? read(child) : undefined;
    };
    const enumValue = <T extends string>(node: Element, allowed: readonly T[]): T => {
      const found = trimXmlWhitespace(value(node));
      return allowed.find(candidate => candidate === found) ?? fail(node, `Expected ${allowed.join(" or ")}.`);
    };
    const direction = (node: Element): CamtDirection => enumValue(node, ["CRDT", "DBIT"]);
    const boolean = (node: Element): boolean => ["true", "1"].includes(enumValue(node, ["true", "false", "1", "0"]));
    const digits = (node: Element): string => {
      const found = trimXmlWhitespace(value(node));
      if (!/^\d+$/.test(found)) fail(node, "Expected an unsigned integer string.");
      return found;
    };
    const currency = (node: Element, found: string): string => {
      if (!/^[A-Z]{3}$/.test(found)) fail(node, "Expected a three-letter currency code.");
      return found;
    };
    const amount = (node: Element): CamtAmount => {
      const lexical = trimXmlWhitespace(value(node));
      if (!/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(lexical)) fail(node, "Expected a decimal amount without an exponent.");
      if (lexical.startsWith("-") && /[1-9]/.test(lexical)) fail(node, "Amounts must be unsigned; use CdtDbtInd for direction.");
      const [integer = "", fraction] = lexical.replace(/^[+\-]/, "").split(".");
      const normalized = (integer.replace(/^0+/, "") || "0") + (fraction ? `.${fraction}` : "");
      // XSD decimal facets count value digits, not insignificant lexical zeros.
      const significant = ((integer.replace(/^0+/, "") || "") + (fraction?.replace(/0+$/, "") ?? "")).replace(/^0+/, "");
      if (significant.length > 18 || (fraction?.replace(/0+$/, "").length ?? 0) > 5) fail(node, "Amount exceeds 18 digits or 5 fractional digits.");
      const ccy = node.attributes.find(attr => attr.name === "Ccy" && attr.namespace === "")?.value;
      if (ccy === undefined) fail(node, "Missing amount currency.");
      return { amount: normalized, currency: currency(node, ccy!) };
    };
    const dateValue = (node: Element, isTime: boolean): string => {
      const found = trimXmlWhitespace(value(node));
      const zone = "(?:Z|[+-](?:(?:0[0-9]|1[0-3]):[0-5][0-9]|14:00))?";
      const time = "T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?|24:00:00(?:\\.0+)?)";
      if (!new RegExp(`^[0-9]{4}-[0-9]{2}-[0-9]{2}${isTime ? time : ""}${zone}$`).test(found)
        || found.startsWith("0000-") || !z.iso.date().safeParse(found.slice(0, 10)).success) fail(node, "Invalid XML date or date-time.");
      return found;
    };
    const date = (node: Element): CamtDate => {
      const day = one(node, "Dt"), time = one(node, "DtTm");
      if (Boolean(day) === Boolean(time)) fail(node, "Expected exactly one of Dt or DtTm.");
      return day ? { kind: "date", value: dateValue(day, false) } : { kind: "dateTime", value: dateValue(time!, true) };
    };
    const code = (node: Element): CamtCode => {
      const standard = one(node, "Cd"), proprietary = one(node, "Prtry");
      if (Boolean(standard) === Boolean(proprietary)) fail(node, "Expected exactly one of Cd or Prtry.");
      return standard ? { kind: "code", value: value(standard) } : { kind: "proprietary", value: value(proprietary!) };
    };
    const bankCode = (node: Element): CamtBankTransactionCode => ({
      domain: optional(node, "Domn", domain => {
        const family = required(domain, "Fmly");
        return { code: reqText(domain, "Cd"), family: reqText(family, "Cd"), subfamily: reqText(family, "SubFmlyCd") };
      }),
      proprietary: optional(node, "Prtry", prop => ({ code: reqText(prop, "Cd"), issuer: text(prop, "Issr") })),
    });
    const agentBic = (node: Element): string | undefined => text(required(node, "FinInstnId"), "BICFI");
    const account = (node: Element): CamtAccount => {
      const id = required(node, "Id");
      const iban = one(id, "IBAN"), other = one(id, "Othr");
      if (Boolean(iban) === Boolean(other)) fail(id, "Expected exactly one of IBAN or Othr.");
      // Bank reports may contain historical/proprietary identifiers. Do not rewrite or invent them.
      return { id: iban ? { kind: "iban", value: value(iban) } : { kind: "other", value: reqText(other!, "Id") },
        currency: optional(node, "Ccy", n => currency(n, value(n))), name: text(node, "Nm"),
        ownerName: optional(node, "Ownr", n => text(n, "Nm")), servicerBic: optional(node, "Svcr", agentBic) };
    };
    const party = (node: Element): CamtParty => {
      const person = one(node, "Pty"), agent = one(node, "Agt");
      if (Boolean(person) === Boolean(agent)) fail(node, "Expected exactly one of Pty or Agt.");
      return person ? { kind: "party", name: text(person, "Nm") } : {
        kind: "agent", name: text(required(agent!, "FinInstnId"), "Nm"), bic: agentBic(agent!),
      };
    };
    const transaction = (node: Element): CamtTransaction => {
      const refs = one(node, "Refs"), parties = one(node, "RltdPties"), agents = one(node, "RltdAgts"), remittance = one(node, "RmtInf"), amounts = one(node, "AmtDtls");
      const ref = (name: string) => refs ? text(refs, name) : undefined;
      const side = (name: string) => parties ? optional(parties, name, party) : undefined;
      const sideAccount = (name: string) => parties ? optional(parties, name, account) : undefined;
      const detailAmount = (name: string) => amounts ? optional(amounts, name, n => amount(required(n, "Amt"))) : undefined;
      return {
        amount: optional(node, "Amt", amount), direction: optional(node, "CdtDbtInd", direction),
        references: {
          messageId: ref("MsgId"), accountServicerReference: ref("AcctSvcrRef"), paymentInformationId: ref("PmtInfId"),
          instructionId: ref("InstrId"), endToEndId: ref("EndToEndId"), uetr: ref("UETR"), transactionId: ref("TxId"),
          mandateId: ref("MndtId"), chequeNumber: ref("ChqNb"), clearingSystemReference: ref("ClrSysRef"),
          accountOwnerTransactionId: ref("AcctOwnrTxId"), accountServicerTransactionId: ref("AcctSvcrTxId"),
          marketInfrastructureTransactionId: ref("MktInfrstrctrTxId"), processingId: ref("PrcgId"),
          proprietary: refs ? children(refs, "Prtry").map(n => ({ type: reqText(n, "Tp"), reference: reqText(n, "Ref") })) : [],
        },
        instructedAmount: detailAmount("InstdAmt"), transactionAmount: detailAmount("TxAmt"), counterValueAmount: detailAmount("CntrValAmt"),
        bankTransactionCode: optional(node, "BkTxCd", bankCode),
        debtor: side("Dbtr"), debtorAccount: sideAccount("DbtrAcct"), creditor: side("Cdtr"), creditorAccount: sideAccount("CdtrAcct"),
        ultimateDebtor: side("UltmtDbtr"), ultimateCreditor: side("UltmtCdtr"),
        debtorAgentBic: agents ? optional(agents, "DbtrAgt", agentBic) : undefined,
        creditorAgentBic: agents ? optional(agents, "CdtrAgt", agentBic) : undefined,
        purpose: optional(node, "Purp", code),
        remittance: { unstructured: remittance ? children(remittance, "Ustrd").map(value) : [], structured: remittance ? children(remittance, "Strd") : [] },
        returnInformation: one(node, "RtrInf"), additionalInformation: text(node, "AddtlTxInf"),
      };
    };
    const detail = (node: Element): CamtEntryDetails => ({
      batch: optional(node, "Btch", batch => ({ messageId: text(batch, "MsgId"), paymentInformationId: text(batch, "PmtInfId"),
        transactionCount: optional(batch, "NbOfTxs", digits), total: optional(batch, "TtlAmt", amount), direction: optional(batch, "CdtDbtInd", direction) })),
      transactions: children(node, "TxDtls").map(transaction),
    });
    const entry = (node: Element): CamtEntry => ({
      reference: text(node, "NtryRef"), amount: amount(required(node, "Amt")), direction: direction(required(node, "CdtDbtInd")),
      reversal: optional(node, "RvslInd", boolean), status: code(required(node, "Sts")),
      bookingDate: optional(node, "BookgDt", date), valueDate: optional(node, "ValDt", date),
      accountServicerReference: text(node, "AcctSvcrRef"), bankTransactionCode: bankCode(required(node, "BkTxCd")),
      details: children(node, "NtryDtls").map(detail), additionalInformation: text(node, "AddtlNtryInf"),
    });
    const report = (node: Element): CamtReport => ({
      id: reqText(node, "Id"), createdAt: optional(node, "CreDtTm", n => dateValue(n, true)),
      electronicSequenceNumber: optional(node, "ElctrncSeqNb", digits), legalSequenceNumber: optional(node, "LglSeqNb", digits),
      pagination: optional(node, "RptPgntn", n => ({ pageNumber: digits(required(n, "PgNb")), lastPage: boolean(required(n, "LastPgInd")) })),
      period: optional(node, "FrToDt", n => ({ from: dateValue(required(n, "FrDtTm"), true), to: dateValue(required(n, "ToDtTm"), true) })),
      copyDuplicate: optional(node, "CpyDplctInd", n => enumValue(n, ["COPY", "DUPL", "CODU"])),
      account: account(required(node, "Acct")),
      balances: children(node, "Bal").map(n => {
        const type = required(n, "Tp");
        return { type: code(required(type, "CdOrPrtry")), subtype: optional(type, "SubTp", code), amount: amount(required(n, "Amt")),
          direction: direction(required(n, "CdtDbtInd")), date: date(required(n, "Dt")) };
      }),
      entries: children(node, "Ntry").map(entry), additionalInformation: text(node, "AddtlRptInf"),
    });
    const body = required(document, "BkToCstmrAcctRpt"), header = required(body, "GrpHdr");
    const reports = children(body, "Rpt");
    if (!reports.length) fail(body, "Expected at least one Rpt.");
    return ok({ version: "camt.052.001.08", messageId: reqText(header, "MsgId"), createdAt: dateValue(required(header, "CreDtTm"), true),
      pagination: optional(header, "MsgPgntn", n => ({ pageNumber: digits(required(n, "PgNb")), lastPage: boolean(required(n, "LastPgInd")) })),
      reports: reports.map(report), document });
  } catch (error) {
    if (error instanceof CamtReadError) return invalid([error.issue]);
    throw error;
  }
}

/** Read bank-independent camt.052.001.08 reports; full XSD validation is separate. */
export const camt = { parse };
