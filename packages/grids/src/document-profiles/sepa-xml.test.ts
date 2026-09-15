import { describe, expect, test } from "bun:test";
import { validateSepaXml } from "@k2b/stdlib/finance/validate";
import { renderSepaBatch } from "./sepa-xml";
import { SepaBatchSchema, sepaPreviewWarnings } from "./sepa-xml-contracts";

const input = () => ({
  destinationKey: "company-payments",
  messageId: "message-1",
  paymentInformationId: "payment-1",
  debtorName: "Company & Partners",
  debtorIban: "DE89370400440532013000",
  executionDate: "2026-09-14",
  rows: [
    {
      businessId: "expense-1",
      endToEndId: "expense-1-payment",
      amount: "12.30",
      creditorName: "Valentin Müller",
      creditorIban: "NL91ABNA0417164300",
      remittance: "Expense 'train' & meal",
    },
  ],
});
const issuedAt = new Date("2026-09-11T12:34:56Z");

describe("SEPA pain.001.001.09 DK GBIC 5", () => {
  test("warns about past dates without mutating captured input", () => {
    const batch = SepaBatchSchema.parse(input());
    const before = structuredClone(batch);
    expect(sepaPreviewWarnings(batch, "2026-09-15")).toEqual(["pastExecutionDate"]);
    expect(sepaPreviewWarnings(batch, "2026-09-14")).toEqual([]);
    expect(sepaPreviewWarnings(batch, "2026-09-13")).toEqual([]);
    expect(batch).toEqual(before);
    const basic = {
      ...batch,
      debtorName: "Company",
      rows: batch.rows.map((row) => ({ ...row, creditorName: "Payee", remittance: "Train - 2026/09" })),
    };
    expect(sepaPreviewWarnings(basic, "2026-09-14")).toEqual([]);
    expect(sepaPreviewWarnings({ ...basic, debtorName: "Müller" }, "2026-09-14")).toEqual([]);
  });

  test("rejects an empty payment batch before rendering", async () => {
    const empty = { ...input(), rows: [] };
    const checked = SepaBatchSchema.safeParse(empty);
    expect(checked.success).toBe(false);
    if (!checked.success) expect(checked.error.issues.some((issue) => issue.path[0] === "rows")).toBe(true);
    await expect(renderSepaBatch(empty, issuedAt)).rejects.toThrow();
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
            businessId: "expense-2",
            endToEndId: "expense-2-payment",
            amount: "0.01",
            creditorBic: "ABNANL2A",
          },
        ],
      },
      issuedAt,
    );
    expect(result).toMatchObject({ rowCount: 2, total: "12.31" });
    const xml = new TextDecoder().decode(result.bytes);
    expect(xml).toContain("<CtrlSum>12.31</CtrlSum>");
    expect(xml.match(/<NbOfTxs>2<\/NbOfTxs>/g)).toHaveLength(2);
    expect(xml).toContain("Company &amp; Partners");
    expect(xml).toContain("Valentin Müller");
    expect(xml).toContain('<InstdAmt Ccy="EUR">0.01</InstdAmt>');
    expect(xml).toContain("<Othr><Id>NOTPROVIDED</Id></Othr>");
    expect(xml).not.toContain("INST");
    expect((await validateSepaXml(xml)).ok).toBe(true);
    expect((await renderSepaBatch(batch, issuedAt)).bytes).toEqual((await renderSepaBatch(batch, issuedAt)).bytes);
  });

  test("rejects invalid IBAN structure/checksum, unsupported currency and imprecise values", async () => {
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
      { creditorName: "Valentin <Example>" },
      { creditorName: "René" },
      { remittance: 'Expense "train"' },
      { remittance: "Fahrt €" },
      { remittance: "   " },
      { currency: "USD" },
      { endToEndId: "x//y" },
      { endToEndId: "/x" },
      { remittance: "a".repeat(141) },
    ])
      await expect(
        (async () => renderSepaBatch(SepaBatchSchema.parse({ ...batch, rows: [{ ...batch.rows[0]!, ...patch }] }), issuedAt))(),
      ).rejects.toThrow();
    expect(SepaBatchSchema.safeParse({ ...batch, executionDate: "2026-02-30" }).success).toBe(false);
    expect(SepaBatchSchema.safeParse({ ...batch, rows: [...batch.rows, ...batch.rows] }).success).toBe(false);
    await expect(
      renderSepaBatch({ ...batch, rows: [batch.rows[0]!, { ...batch.rows[0]!, businessId: "another" }] }, issuedAt),
    ).rejects.toThrow();
  });

  test("schema verification rejects wrong namespaces, malformed XML, unsafe entities and non-EUR amounts", async () => {
    const xml = new TextDecoder().decode((await renderSepaBatch(input(), issuedAt)).bytes);
    for (const invalid of [
      xml.replace('Ccy="EUR"', 'Ccy="USD"'),
      xml.replace("pain.001.001.09", "pain.001.001.03"),
      xml.replace("<PmtMtd>TRF</PmtMtd>", "<PmtMtd>CHK</PmtMtd>"),
      xml.slice(0, -3),
      '<!DOCTYPE Document SYSTEM "file:///etc/passwd"><Document/>',
    ])
      expect((await validateSepaXml(invalid)).ok).toBe(false);
  });
});
