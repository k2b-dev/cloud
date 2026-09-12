import { expect, test } from "bun:test";
import type { FinancialExportPreview } from "../../../api/workflow-document-confirmations";
import { financialExportTotals } from "./financial-export-preview";

test("financial preview totals retain cents across the complete batch and separate debit from credit", () => {
  const preview: FinancialExportPreview = {
    receiptId: "ABC123",
    sha256: "a".repeat(64),
    number: "DATEV-1",
    filename: "EXTF_test.csv",
    confirmedAt: null,
    source: { kind: "query", capturedAt: "2026-09-11T00:00:00Z", rowCount: 103, selectionLimit: null, query: "test" },
    kind: "datev-csv",
    version: 1,
    input: {
      destinationKey: "test",
      consultantNumber: "1001",
      clientNumber: "1",
      fiscalYearStart: "2026-01-01",
      accountLength: 4,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      label: "Test",
      finalize: false,
      rows: Array.from({ length: 103 }, (_, index) => ({
        businessId: String(index),
        entryId: String(index),
        amount: "0.10",
        direction: index < 101 ? "S" : "H",
        account: "4400",
        counterAccount: "1200",
        documentDate: "2026-09-11",
        documentNumber: "TEST",
      })),
    },
  };
  expect(financialExportTotals(preview)).toEqual([
    { key: "debit", value: "10.10" },
    { key: "credit", value: "0.20" },
  ]);
});
