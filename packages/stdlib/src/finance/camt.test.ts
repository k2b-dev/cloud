import { describe, expect, test } from "bun:test";
import { camt } from "./index";
import { validateCamtXml, camtSchemaSha256 } from "./validate";
import { unwrap } from "../result";
import { camtExampleXml as xml } from "../../examples/camt";

const parse = (input = xml) => unwrap(camt.parse(input));
const entry = (input = xml) => parse(input).reports[0]!.entries[0]!;
const issue = (input: string) => {
  const result = camt.parse(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw Error("Expected an error");
  return result.error.issues[0]!;
};

describe("camt.052.001.08", () => {
  test("schema-valid account report preserves entry/detail hierarchy and exact strings", async () => {
    expect(await validateCamtXml(xml)).toEqual({ ok: true, data: undefined });
    const result = parse();
    expect(result.version).toBe("camt.052.001.08");
    expect(result.messageId).toBe("report-message-1");
    expect(result.createdAt).toBe("2026-09-13T12:00:00+02:00");
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report.pagination).toEqual({ pageNumber: "1", lastPage: true });
    expect(report.electronicSequenceNumber).toBe("00042");
    expect(report.balances[0]).toMatchObject({ type: { kind: "code", value: "ITBD" }, amount: { amount: "1000.00", currency: "EUR" }, direction: "CRDT" });
    expect(report.entries).toHaveLength(2);
    const first = report.entries[0]!;
    expect(first.amount).toEqual({ amount: "125.50", currency: "EUR" });
    expect(first.direction).toBe("DBIT");
    expect(first.details[0]!.batch?.transactionCount).toBe("2");
    expect(first.details[0]!.transactions.map(tx => tx.amount?.amount)).toEqual(["100.00", "25.50"]);
    expect(first.details[0]!.transactions[0]!.creditor).toEqual({ kind: "party", name: "Example & Partners" });
    expect(first.details[0]!.transactions[0]!.remittance.unstructured).toEqual(["Invoice 42", "Second line"]);
    expect(first.details[0]!.transactions[0]!.remittance.structured[0]?.name).toBe("Strd");
    expect(first.details[0]!.transactions[1]!.references.endToEndId).toBe("NOTPROVIDED");
    expect(report.entries[1]!.status).toEqual({ kind: "code", value: "PDNG" });
    expect(report.entries[1]!.details).toEqual([]);
    expect(report.entries[1]!.bookingDate).toBeUndefined();
    expect(first.reversal).toBeUndefined();
  });

  test("multiple reports, proprietary accounts/status and independent detail groups", async () => {
    const extra = '<Rpt><Id>other</Id><Acct><Id><Othr><Id>000-account</Id></Othr></Id><Ccy>JPY</Ccy></Acct></Rpt>';
    const input = xml.replace('</BkToCstmrAcctRpt>', `${extra}</BkToCstmrAcctRpt>`)
      .replace('<Sts><Cd>PDNG</Cd></Sts>', '<Sts><Prtry>INTERNAL-PENDING</Prtry></Sts>')
      .replace('</NtryDtls>', '</NtryDtls><NtryDtls><TxDtls><Refs><TxId>no-amount</TxId></Refs></TxDtls></NtryDtls>');
    expect((await validateCamtXml(input)).ok).toBe(true);
    const reports = parse(input).reports;
    expect(reports).toHaveLength(2);
    expect(reports[1]!.account.id).toEqual({ kind: "other", value: "000-account" });
    expect(reports[1]!.entries).toEqual([]);
    expect(reports[0]!.entries[0]!.details).toHaveLength(2);
    const partial = reports[0]!.entries[0]!.details[1]!.transactions[0]!;
    expect(partial.amount).toBeUndefined();
    expect(partial.direction).toBeUndefined();
    expect(partial.creditor).toBeUndefined();
    expect(reports[0]!.entries[1]!.status.kind).toBe("proprietary");
  });

  test("prefixes resolve by URI; unsupported versions and namespace spoofing fail", () => {
    const prefixed = xml.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)/g, '<$1camt:$2').replace('xmlns=', 'xmlns:camt=');
    expect(parse(prefixed).reports).toEqual(parse().reports);
    for (const version of ["camt.052.001.02", "camt.052.001.09", "camt.053.001.08", "other"]) {
      expect(issue(xml.replaceAll("camt.052.001.08", version)).code).toBe("unsupported_format");
    }
    expect(issue(xml.replace('xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08"', '')).code).toBe("unsupported_format");
    expect(issue(xml.replace('<Amt Ccy="EUR">125.50', '<Amt xmlns="urn:evil" Ccy="EUR">125.50')).message).toContain("namespace");
    expect(issue(xml.replace('<NtryDtls>', '<NtryDtls xmlns="urn:evil">')).message).toContain("namespace");
  });

  test("amounts never pass through Number, retain currencies and five decimal places", async () => {
    for (const amount of ["9007199254740993.01", "0", "0.00001", "+00012.30000", "100000000000000000.00"]) {
      const input = xml.replace('125.50</Amt>', `${amount}</Amt>`);
      expect((await validateCamtXml(input)).ok).toBe(true);
      expect(entry(input).amount.amount).toBe(amount === "+00012.30000" ? "12.30000" : amount);
    }
    expect(entry(xml.replace('<Amt Ccy="EUR">125.50', '<Amt Ccy="KWD">125.501')).amount).toEqual({ amount: "125.501", currency: "KWD" });
    for (const bad of ["-1.00", "1e2", "NaN", "Infinity", "1,23", "0.000001", "1000000000000000000.00"]) {
      const error = issue(xml.replace('125.50</Amt>', `${bad}</Amt>`));
      expect(error.path).toEqual(["xml", "Document", "BkToCstmrAcctRpt", 0, "Rpt", 0, "Ntry", 0, "Amt", 0]);
      expect(error.line).toBeGreaterThan(0);
    }
  });

  test("reversals do not flip credit/debit; dates retain time zones and precision", () => {
    const input = xml.replace('<Sts><Cd>BOOK</Cd></Sts>', '<RvslInd>true</RvslInd><Sts><Cd>BOOK</Cd></Sts>')
      .replace('<BookgDt><Dt>2026-09-13</Dt></BookgDt>', '<BookgDt><DtTm>2026-09-13T23:59:59.123456-04:00</DtTm></BookgDt>');
    expect(entry(input).reversal).toBe(true);
    expect(entry(input).direction).toBe("DBIT");
    expect(entry(input).bookingDate).toEqual({ kind: "dateTime", value: "2026-09-13T23:59:59.123456-04:00" });
    for (const date of ["2026-02-30", "0000-01-01", "2026-13-01", "2026-09-13+15:00"]) {
      expect(issue(xml.replace('<Dt>2026-09-13</Dt>', `<Dt>${date}</Dt>`)).message).toContain("date");
    }
    expect(issue(xml.replace('<CdtDbtInd>DBIT</CdtDbtInd>', '<CdtDbtInd>OTHER</CdtDbtInd>')).message).toContain("CRDT");
  });

  test("duplicate scalar fields, missing required data and conflicting choices fail", () => {
    for (const input of [
      xml.replace('<MsgId>report-message-1</MsgId>', ''),
      xml.replace('<MsgId>report-message-1</MsgId>', '<MsgId>a</MsgId><MsgId>b</MsgId>'),
      xml.replace('<Sts><Cd>BOOK</Cd></Sts>', '<Sts><Cd>BOOK</Cd><Prtry>other</Prtry></Sts>'),
      xml.replace('<MsgId>report-message-1</MsgId>', '<MsgId><nested/></MsgId>'),
      xml.replace('Ccy="EUR">125.50', '>125.50'),
      xml.replace('<Rpt>', '<Other>').replace('</Rpt>', '</Other>'),
    ]) expect(issue(input).code).toBe("invalid_input");
  });

  test("BOM, comments, CDATA and escaped text are safe; malformed XML and DTDs are rejected", async () => {
    const withText = '\uFEFF' + xml.replace('Invoice 42', '<![CDATA[Invoice <42> & details]]>').replace('<Rpt>', '<!-- report --><Rpt>');
    expect(entry(withText).details[0]!.transactions[0]!.remittance.unstructured[0]).toBe("Invoice <42> & details");
    expect((await validateCamtXml(withText)).ok).toBe(true);
    for (const input of [
      xml.slice(0, -5), `${xml}<Other/>`, xml.replace('Invoice 42', '&unknown;'),
      xml.replace('Invoice 42', '&#0;'), xml.replace('Invoice 42', '\u0000'),
      xml.replace('<Document ', '<!DOCTYPE Document SYSTEM "https://example.invalid/a.dtd"><Document '),
      xml.replace('<Document ', '<!DOCTYPE Document [<!ENTITY ex SYSTEM "file:///etc/passwd">]><Document '),
      xml.replace('version="1.0"', 'version="1.1"'),
    ]) {
      expect(issue(input).code).toBe("invalid_xml");
      expect((await validateCamtXml(input)).ok).toBe(false);
    }
  });

  test("resource limits reject before tree growth or WASM validation", async () => {
    for (const options of [{ maxCharacters: 10 }, { maxDepth: 3 }, { maxElements: 5 }]) {
      const parsed = camt.parse(xml, options);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.issues[0]?.code).toBe("input_limit");
      expect((await validateCamtXml(xml, options)).ok).toBe(false);
    }
    for (const limit of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(camt.parse(xml, { maxElements: limit }).ok).toBe(false);
    }
  });

  test("additional XML survives the typed projection; output is deterministic and JSON-serializable", () => {
    const input = xml.replace('</BkToCstmrAcctRpt>', '<SplmtryData><Envlp><x:Info xmlns:x="urn:example" id="007">a<x:Detail/>b</x:Info></Envlp></SplmtryData></BkToCstmrAcctRpt>');
    const parsed = parse(input);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(parse(input)));
    const roundtrip = JSON.parse(JSON.stringify(parsed));
    expect(roundtrip).toEqual(parsed);
    expect(JSON.stringify(parsed.document)).toContain('"namespace":"urn:example"');
    expect(JSON.stringify(parsed.document)).toContain('"value":"007"');
    expect(JSON.stringify(parsed.document)).toContain('"name":"Detail"');
  });

  test("full XSD checking is optional and catches rules beyond the typed projection", async () => {
    const reordered = xml.replace('<MsgId>report-message-1</MsgId><CreDtTm>2026-09-13T12:00:00+02:00</CreDtTm>', '<CreDtTm>2026-09-13T12:00:00+02:00</CreDtTm><MsgId>report-message-1</MsgId>');
    expect(camt.parse(reordered).ok).toBe(true);
    const result = await validateCamtXml(reordered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.issues[0]?.code).toBe("schema_mismatch");
    expect(camtSchemaSha256).toHaveLength(64);
  });
});

// Public MNB examples, Document extracted from the published AppHdr+Document fragments.
// URLs and SHA-256 are recorded in docs/camt.md. Tests never access the network.
test("MNB bank examples demonstrate non-Sparkasse accounts, HUF and reports without entries", async () => {
  for (const [file, expected] of [["type1", ["3000000"]], ["viber1", ["568500000", "4268500000"]]] as const) {
    const source = await Bun.file(new URL(`../../examples/fixtures/camt-mnb-${file}.xml`, import.meta.url)).text();
    expect((await validateCamtXml(source)).ok).toBe(true);
    const report = parse(source).reports[0]!;
    expect(report.account.id).toEqual({ kind: "other", value: "OTPVHUHBXXX" });
    expect(report.balances.map(balance => balance.amount.amount)).toEqual([...expected]);
    expect(report.balances.every(balance => balance.amount.currency === "HUF")).toBe(true);
    expect(report.entries).toEqual([]);
  }
});

test("optional amount details, account owners, agents and document pagination are preserved", async () => {
  const input = xml.replace('</GrpHdr>', '<MsgPgntn><PgNb>2</PgNb><LastPgInd>false</LastPgInd></MsgPgntn></GrpHdr>')
    .replace('<Nm>Example account</Nm>', '<Nm>Example account</Nm><Ownr><Nm>Owner</Nm></Ownr><Svcr><FinInstnId><BICFI>ABNANL2A</BICFI></FinInstnId></Svcr>')
    .replace('<RltdPties>', '<AmtDtls><InstdAmt><Amt Ccy="USD">110.50</Amt></InstdAmt><TxAmt><Amt Ccy="EUR">100.00</Amt></TxAmt><CntrValAmt><Amt Ccy="GBP">90.12</Amt></CntrValAmt></AmtDtls><RltdPties>')
    .replace('</RltdPties>', '</RltdPties><RltdAgts><CdtrAgt><FinInstnId><BICFI>ABNANL2A</BICFI></FinInstnId></CdtrAgt></RltdAgts>');
  expect((await validateCamtXml(input)).ok).toBe(true);
  const result = parse(input);
  expect(result.pagination).toEqual({ pageNumber: "2", lastPage: false });
  expect(result.reports[0]!.account.ownerName).toBe("Owner");
  expect(result.reports[0]!.account.servicerBic).toBe("ABNANL2A");
  const tx = result.reports[0]!.entries[0]!.details[0]!.transactions[0]!;
  expect(tx.instructedAmount).toEqual({ amount: "110.50", currency: "USD" });
  expect(tx.transactionAmount).toEqual({ amount: "100.00", currency: "EUR" });
  expect(tx.counterValueAmount).toEqual({ amount: "90.12", currency: "GBP" });
  expect(tx.creditorAgentBic).toBe("ABNANL2A");
});

test("XSD verification uses only the pinned local schema and disposes state across calls", async () => {
  const { xmlRegisterInputProvider, xmlCleanupInputProvider } = await import("libxml2-wasm");
  const requested: string[] = [];
  xmlRegisterInputProvider({ match: (url: string) => { requested.push(url); return false; }, open: () => undefined, read: () => 0, close: () => false });
  try {
    const hinted = xml.replace('<Document ', '<Document xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:iso:std:iso:20022:tech:xsd:camt.052.001.08 https://example.invalid/schema.xsd" ');
    const results = await Promise.all([hinted, xml, xml.replace('<MsgId>report-message-1</MsgId>', '')].map(source => validateCamtXml(source)));
    expect(results.map(result => result.ok)).toEqual([true, true, false]);
    expect(requested).toEqual([]);
  } finally { xmlCleanupInputProvider(); }
});
