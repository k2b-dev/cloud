import { validateSepaXml as checkSepaXml } from "./validate";
import { describe, expect, test } from "bun:test";
import { sepa, type SepaBatch } from "./index";
import { unwrap } from "../result";
const renderSepaBatch = (input: SepaBatch) => unwrap(sepa.serialize(input));
const validateSepaXml = async (xml: string) => unwrap(await checkSepaXml(xml));


const input = () => ({
  format: "sepa-sct-pain.001.001.09-gbic-5" as const,
  currency: "EUR" as const,
  createdAt: "2026-09-11T12:34:56.000Z",
  messageId: "message-1",
  paymentInformationId: "payment-1",
  debtorName: "Company & Partners",
  debtorIban: "DE89370400440532013000",
  executionDate: "2026-09-14",
  rows: [
    {
      endToEndId: "expense-1-payment",
      amount: "12.30",
      creditorName: "Valentin (Example)",
      creditorIban: "NL91ABNA0417164300",
      remittance: "Expense 'train' & meal",
    },
  ],
});

describe("SEPA pain.001.001.09 DK GBIC 5", () => {
  test("rejects an empty payment batch before rendering", async () => {
    const empty = { ...input(), rows: [] };
    const checked = sepa.validate(empty);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.issues.some((issue) => issue.path[0] === "rows")).toBe(true);
    expect(() => renderSepaBatch(empty)).toThrow();
  });

  test("produces locally schema-valid SCT with exact totals and escaped values", async () => {
    const batch = input();
    const result = await renderSepaBatch(
      {
        ...batch,
        rows: [
          ...batch.rows,
          {
            ...batch.rows[0]!,
            endToEndId: "expense-2-payment",
            amount: "0.01",
            creditorBic: "ABNANL2A",
          },
        ],
      },
    );
    expect(result).toMatchObject({ rowCount: 2, total: "12.31" });
    const xml = new TextDecoder().decode(result.bytes);
    expect(xml).toContain("<CtrlSum>12.31</CtrlSum>");
    expect(xml.match(/<NbOfTxs>2<\/NbOfTxs>/g)).toHaveLength(2);
    expect(xml).toContain("Company &amp; Partners");
    expect(xml).toContain("Valentin (Example)");
    expect(xml).toContain('<InstdAmt Ccy="EUR">0.01</InstdAmt>');
    expect(xml).toContain("<Othr><Id>NOTPROVIDED</Id></Othr>");
    expect(xml).not.toContain("INST");
    await expect(validateSepaXml(xml)).resolves.toBeUndefined();
    expect((await renderSepaBatch(batch)).bytes).toEqual((await renderSepaBatch(batch)).bytes);
  });

  test("rejects invalid IBAN structure/checksum, unsupported currency and imprecise values", () => {
    const batch = input();
    for (const patch of [
      { creditorIban: "DE89370400440532013001" },
      { creditorIban: "DE891234" },
      { creditorIban: "ZZ89370400440532013000" },
      { creditorIban: "de89370400440532013000" },
      { creditorIban: "DE89 3704 0044 0532 0130 00" },
      { amount: "1.001" },
      { amount: "0.00" },
      { amount: "1000000000.00" },
      { amount: 12.3 },
      { amount: "NaN" },
      { creditorName: "a".repeat(71) },
      { creditorName: "line\nbreak" },
      { currency: "USD" },
      { endToEndId: "x//y" },
      { endToEndId: "/x" },
      { remittance: "a".repeat(141) },
    ])
      expect(sepa.validate({ ...batch, rows: [{ ...batch.rows[0]!, ...patch }] }).ok).toBe(false);
    expect(sepa.validate({ ...batch, executionDate: "2026-02-30" }).ok).toBe(false);
    expect(sepa.validate({ ...batch, rows: [...batch.rows, ...batch.rows] }).ok).toBe(false);
    expect(sepa.validate({ ...batch, rows: [batch.rows[0]!, { ...batch.rows[0]!, businessId: "another" }] }).ok).toBe(
      false,
    );
  });

  test("schema verification rejects wrong namespaces, malformed XML, unsafe entities and non-EUR amounts", async () => {
    const xml = new TextDecoder().decode((await renderSepaBatch(input())).bytes);
    for (const invalid of [
      xml.replace('Ccy="EUR"', 'Ccy="USD"'),
      xml.replace("pain.001.001.09", "pain.001.001.03"),
      xml.replace("<PmtMtd>TRF</PmtMtd>", "<PmtMtd>CHK</PmtMtd>"),
      xml.slice(0, -3),
      '<!DOCTYPE Document SYSTEM "file:///etc/passwd"><Document/>',
    ])
      await expect(validateSepaXml(invalid)).rejects.toThrow();
  });
});

test("header validation needs neither execution IDs nor rows and shares field rules", () => {
  const { rows, createdAt, messageId, paymentInformationId, ...header } = input();
  expect(unwrap(sepa.validateHeader(header))).toEqual(header);
  expect(sepa.validate(header).ok).toBe(false);
  expect(sepa.validateHeader({ ...header, messageId }).ok).toBe(false);
  for (const patch of [{ executionDate: "2026-02-30" }, { debtorIban: "DE891234" }, { debtorName: " " }, { currency: "USD" }]) {
    const early = sepa.validateHeader({ ...header, ...patch });
    const batch = sepa.validate({ ...header, ...patch, rows, createdAt, messageId, paymentInformationId });
    expect(early.ok).toBe(false);
    expect(batch.ok).toBe(false);
    if (!early.ok && !batch.ok) expect(batch.error.issues).toEqual(early.error.issues);
  }
});

test("DK character repertoire is explicit and is never silently transliterated", async () => {
  const batch = input();
  const name = "ÄÖÜäöüß & * $ % + ? / : ( ) . , ' -";
  const file = unwrap(sepa.serialize({ ...batch, debtorName: name }));
  expect(new TextDecoder().decode(file.bytes)).toContain("ÄÖÜäöüß &amp;");
  await validateSepaXml(new TextDecoder().decode(file.bytes));
  for (const value of ['"', "<", ">", "é", "😀", " ", "\u0000", "\ud800"]) {
    expect(sepa.validate({ ...batch, debtorName: value }).ok).toBe(false);
    for (const field of ["creditorName", "remittance"] as const) {
      const result = sepa.validate({ ...batch, rows: [{ ...batch.rows[0]!, [field]: value }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.issues[0]?.path).toEqual(["rows", 0, field]);
    }
  }
});
