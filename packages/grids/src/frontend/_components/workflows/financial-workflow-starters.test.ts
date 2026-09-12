import { expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { parseGridsQueryDsl } from "../../../query-dsl/parser";
import { buildWorkflowCatalog } from "../../../service/workflow-catalog";
import { compileAndBindGridsWorkflowSource } from "../../../workflows/binder";
import { expensePaymentStarterSource, invoiceAccountingStarterSource } from "./financial-workflow-starters";

const catalog = buildWorkflowCatalog({
  tables: [{ id: "11111111-1111-4111-8111-111111111111", shortId: "TBL001", name: "Expenses", kind: "stored" }],
  fieldsByTable: new Map(),
  templates: [],
  emailTemplates: [],
});

test("invoice accounting starter consumes issued totals and explicitly selected accounting fields", async () => {
  const source = invoiceAccountingStarterSource({
    header: {
      destinationKey: "ledger",
      consultantNumber: "12345",
      clientNumber: "1",
      fiscalYearStart: "2026-01-01",
      accountLength: 4,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      label: "Invoices",
      finalize: false,
    },
    fields: { direction: "FLD001", account: "FLD002", counterAccount: "FLD003" },
  });
  const result = await compileAndBindGridsWorkflowSource(source, catalog);
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
  expect(source).toContain("grossAmount");
  expect(source).toContain("FLD001");
  expect(source).not.toContain("query:");
});

test("expense payment starter validates its GQL and refuses unfinished selections before capturing payments", async () => {
  const source = expensePaymentStarterSource({
    tableId: "TBL001",
    fieldReferences: ["export_businessId", "EXPORT_AMOUNT"],
    header: { destinationKey: "payments", debtorName: "Example", debtorIban: "DE89370400440532013000", executionDate: "2026-09-15" },
    fields: { businessId: "FLD001", amount: "FLD002", creditorName: "FLD003", creditorIban: "FLD004", remittance: "FLD005" },
    notFinalizedMessage: "Finalize every selected reimbursement before creating a payment file.",
  });
  const queries = new Set<string>();
  const result = await compileAndBindGridsWorkflowSource(source, catalog, async (query) => {
    const parsed = parseGridsQueryDsl(query);
    expect(parsed.ok, parsed.ok ? undefined : JSON.stringify(parsed.diagnostics)).toBe(true);
    queries.add(query);
    return ok({ source: query, schemaHash: "a".repeat(64), schemaHashVersion: 3 as const });
  });
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true);
  expect(queries.size).toBe(2);
  expect(source).toContain("sourceVersions: data");
  expect(source).toContain("_export_businessId");
  expect(source).toContain("_export_amount");
  expect(source).toContain("awaitingReview");
  expect(source).toContain("fail:");
  expect(source).not.toContain("triggers:");
});
