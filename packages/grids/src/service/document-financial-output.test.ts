import { describe, expect, test } from "bun:test";
import type { WorkflowQueryCapture } from "../workflows/query-contracts";
import { type FinancialDocumentOutput, normalizeFinancialDocumentOutput } from "./document-financial-output";

const config: FinancialDocumentOutput = {
  kind: "datev-csv",
  version: 1,
  header: {
    destinationKey: "bookkeeping",
    consultantNumber: "12345",
    clientNumber: "1",
    fiscalYearStart: "2026-01-01",
    accountLength: 4,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    label: "September",
    finalize: false,
  },
  mapping: {
    businessId: "business",
    entryId: "entry",
    amount: "total",
    direction: "side",
    account: "account",
    counterAccount: "other",
    documentDate: "date",
    documentNumber: "number",
    text: "note",
  },
};
const capture = (amount: string | number | null = "12.3000"): WorkflowQueryCapture["payload"] => ({
  version: 1,
  columns: Object.values(config.mapping).map((key) => ({ key, label: key, type: "text", sqlType: "text" })),
  rows: [
    {
      business: "invoice-1",
      entry: "main",
      total: amount,
      side: "S",
      account: "00440",
      other: "70000",
      date: "2026-09-11",
      number: "RE-1",
      note: null,
    },
  ],
  rowOrigins: [{ recordId: null, tableId: null }],
  rowCount: 1,
  capturedAt: "2026-09-11T12:00:00.000Z",
  complete: true,
  selectionLimit: null,
  source: "from table {ABC123}\nselect total",
  schemaHash: "a".repeat(64),
  context: {},
  tableIds: ["00000000-0000-4000-8000-000000000001"],
});
const ids = { messageId: "receipt-1", paymentInformationId: "receipt-1" };

describe("financial export normalization", () => {
  test("uses the calendar day of a serialized SQL date without truncating timestamps", () => {
    const original = capture();
    const source = {
      ...original,
      columns: original.columns.map((column) => (column.key === "date" ? { ...column, type: "date", sqlType: "date" } : column)),
      rows: original.rows.map((row) => ({ ...row, date: "2026-09-11T00:00:00.000Z" })),
    };
    expect(normalizeFinancialDocumentOutput(config, source, ids)).toEqual(normalizeFinancialDocumentOutput(config, original, ids));
    expect(source.rows[0]?.date).toBe("2026-09-11T00:00:00.000Z");
    for (const sqlType of ["text", "timestamptz"]) {
      expect(
        normalizeFinancialDocumentOutput(
          config,
          { ...source, columns: source.columns.map((column) => (column.key === "date" ? { ...column, sqlType } : column)) },
          ids,
        ).ok,
      ).toBe(false);
    }
    expect(
      normalizeFinancialDocumentOutput(config, { ...source, rows: [{ ...source.rows[0], date: "2026-09-11T12:00:00.000Z" }] }, ids).ok,
    ).toBe(false);
  });
  test("declared identities reject duplicate join rows but do not infer economic equivalence", () => {
    const source = capture();
    const first = source.rows[0]!;
    const repeated = { ...source, rows: [first, { ...first }], rowCount: 2, rowOrigins: [...source.rowOrigins, ...source.rowOrigins] };
    expect(normalizeFinancialDocumentOutput(config, repeated, ids).ok).toBe(false);
    const separateEntry = normalizeFinancialDocumentOutput(
      config,
      { ...repeated, rows: [first, { ...first, entry: "another-line" }] },
      ids,
    );
    expect(separateEntry.ok).toBe(true);
    if (!separateEntry.ok) throw separateEntry.error;
    expect(separateEntry.data.input.rows.map((row) => row.amount)).toEqual(["12.30", "12.30"]);
    const renamedBusiness = normalizeFinancialDocumentOutput(config, { ...source, rows: [{ ...first, business: "author-renamed" }] }, ids);
    expect(renamedBusiness.ok).toBe(true);
    if (!renamedBusiness.ok) throw renamedBusiness.error;
    expect(renamedBusiness.data.input.rows[0]?.businessId).toBe("author-renamed");
  });
  test("maps readable GQL aliases to compiler-generated cell keys without confusing either value", () => {
    const source = capture();
    const columns = source.columns.map((column, index) => ({ ...column, key: `q_col_${index}` }));
    const rows = source.rows.map((row) =>
      Object.fromEntries(
        source.columns.map((column, index) => {
          const value = row[column.key];
          if (value === undefined) throw new Error(`Missing fixture column ${column.key}`);
          return [`q_col_${index}`, value];
        }),
      ),
    );
    expect(normalizeFinancialDocumentOutput(config, { ...source, columns, rows }, ids)).toEqual(
      normalizeFinancialDocumentOutput(config, source, ids),
    );
    expect(
      normalizeFinancialDocumentOutput({ ...config, mapping: { ...config.mapping, amount: "q_col_2" } }, { ...source, columns, rows }, ids)
        .ok,
    ).toBe(false);
    const duplicate = columns.map((column, index) => (index === 1 ? { ...column, label: columns[0]!.label } : column));
    expect(normalizeFinancialDocumentOutput(config, { ...source, columns: duplicate, rows }, ids).ok).toBe(false);
  });

  test("normalizes harmless decimal zeros without changing captured data or string account IDs", () => {
    const source = capture();
    const result = normalizeFinancialDocumentOutput(config, source, ids);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.input.rows[0]).toMatchObject({ amount: "12.30", account: "00440" });
    expect(result.data.input.rows[0]).not.toHaveProperty("text");
    expect(source.rows[0]?.total).toBe("12.3000");
    expect(normalizeFinancialDocumentOutput(config, capture("12.30"), ids)).toEqual(result);
    expect(normalizeFinancialDocumentOutput(config, capture(12), ids).ok).toBe(true);
  });

  test("rejects rounding and floating-point money with a localized row error", () => {
    for (const value of ["12.301", "1e2", "-1.00", "0", 12.3, Number.MAX_SAFE_INTEGER + 1, null]) {
      const result = normalizeFinancialDocumentOutput(config, capture(value), ids, "de");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected invalid money");
      expect(result.error.message).toContain("Zeile 1");
    }
  });

  test("requires declared unique columns and bounded safe field diagnostics", () => {
    const source = capture();
    expect(normalizeFinancialDocumentOutput(config, { ...source, columns: [] }, ids).ok).toBe(false);
    expect(normalizeFinancialDocumentOutput(config, { ...source, columns: [...source.columns, source.columns[0]!] }, ids).ok).toBe(false);
    const invalid = { ...source, rows: [{ ...source.rows[0], number: "sensitive invalid number with spaces" }] };
    const result = normalizeFinancialDocumentOutput(config, invalid, ids, "de");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid document number");
    expect(result.error.message).toContain("rows.0.documentNumber");
    expect(result.error.message).not.toContain("sensitive");
  });
});
