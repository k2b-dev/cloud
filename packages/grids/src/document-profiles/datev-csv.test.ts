import { describe, expect, test } from "bun:test";
import { renderDatevBatch } from "./datev-csv";
import { DatevBatchSchema } from "./datev-csv-contracts";

const input = () => ({
  destinationKey: "company-accounting",
  consultantNumber: "29098",
  clientNumber: "55003",
  fiscalYearStart: "2026-01-01",
  accountLength: 4,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  label: "September 2026",
  finalize: false,
  rows: [
    {
      businessId: "invoice-2026-1",
      entryId: "main",
      amount: "123.45",
      direction: "S" as const,
      account: "00440",
      counterAccount: "70000",
      documentDate: "2026-09-11",
      documentNumber: "RE-2026-1",
      text: 'Büro; "Miete"',
      taxKey: "0009",
      costCenter1: "Finance",
    },
  ],
});
const issuedAt = new Date("2026-09-11T12:34:56.789Z");

describe("DATEV 700/13 EUR batch", () => {
  test("rejects an empty booking batch before rendering", () => {
    const empty = { ...input(), rows: [] };
    const checked = DatevBatchSchema.safeParse(empty);
    expect(checked.success).toBe(false);
    if (!checked.success) expect(checked.error.issues.some((issue) => issue.path[0] === "rows")).toBe(true);
    expect(() => renderDatevBatch(empty, issuedAt)).toThrow();
  });

  test("emits BOM, 31 header fields, 125 columns, CRLF and exact values", () => {
    const result = renderDatevBatch(input(), issuedAt);
    expect([...result.bytes.slice(0, 3)]).toEqual([239, 187, 191]);
    const [header, columns, row, end] = new TextDecoder().decode(result.bytes).split("\r\n");
    expect(header?.split(";")).toHaveLength(31);
    expect(header).toStartWith('"EXTF";700;21;"Buchungsstapel";13;20260911123456789;');
    expect(columns?.split(";")).toHaveLength(125);
    expect(row).toStartWith('123,45;"S";"EUR";;;;00440;70000;"0009";1109;"RE-2026-1";');
    expect(row).toContain('"Büro; ""Miete"""');
    expect(end).toBe("");
    expect(result).toMatchObject({ rowCount: 1, businessCount: 1, debitTotal: "123.45", creditTotal: "0.00" });
    expect(renderDatevBatch(input(), issuedAt).bytes).toEqual(result.bytes);
  });

  test("keeps totals exact and distinguishes multiple lines of one transaction", () => {
    const batch = input();
    const row = batch.rows[0]!;
    const result = renderDatevBatch(
      {
        ...batch,
        rows: [
          { ...row, amount: "9999999999.99" },
          { ...row, entryId: "other", amount: "0.01" },
          { ...row, businessId: "correction-1", amount: "3.00", direction: "H" },
        ],
      },
      issuedAt,
    );
    expect(result).toMatchObject({ rowCount: 3, businessCount: 2, debitTotal: "10000000000.00", creditTotal: "3.00" });
    expect(DatevBatchSchema.safeParse({ ...batch, rows: [row, row] }).success).toBe(false);
  });

  test("rejects precision loss, unsupported fields, dates, controls and overlong accounts", () => {
    const batch = input();
    const row = batch.rows[0]!;
    for (const patch of [
      { amount: "0.00" },
      { amount: "-1.00" },
      { amount: "1.001" },
      { amount: 1.1 },
      { amount: "01.00" },
      { amount: "garbage" },
      { documentDate: "2026-02-30" },
      { documentDate: "2026-10-01" },
      { account: "100000" },
      { account: "0000" },
      { taxKey: "9" },
      { documentNumber: "RE 1" },
      { text: "line\nbreak" },
      { text: "\u0000" },
      { currency: "USD" },
      { businessId: " " },
      { entryId: "x " },
    ])
      expect(DatevBatchSchema.safeParse({ ...batch, rows: [{ ...row, ...patch }] }).success).toBe(false);
    expect(DatevBatchSchema.safeParse({ ...batch, periodEnd: "2027-01-01" }).success).toBe(false);
    expect(DatevBatchSchema.safeParse({ ...batch, consultantNumber: "1000" }).success).toBe(false);
    expect(DatevBatchSchema.safeParse({ ...batch, fiscalYearStart: "garbage" }).success).toBe(false);
  });

  test("preserves DATEV import-finalization explicitly without setting it by default", () => {
    const batch = input();
    for (const finalize of [false, true]) {
      const row = { ...batch.rows[0]!, text: "Rent" };
      const lines = new TextDecoder().decode(renderDatevBatch({ ...batch, rows: [row], finalize }, issuedAt).bytes).split("\r\n");
      expect(lines[0]?.split(";")[20]).toBe(finalize ? "1" : "0");
      expect(lines[2]?.split(";")[113]).toBe(finalize ? "1" : "0");
    }
    const { finalize: _, ...missing } = batch;
    expect(DatevBatchSchema.safeParse(missing).success).toBe(false);
  });
});
