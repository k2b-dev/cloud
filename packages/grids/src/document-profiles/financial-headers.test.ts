import { expect, test } from "bun:test";
import { DatevBatchSchema, DatevHeaderSchema } from "./datev-csv-contracts";
import { SepaHeaderSchema } from "./sepa-xml-contracts";

test("DATEV header and complete batch enforce the same fiscal period", () => {
  const header = {
    destinationKey: "ledger",
    consultantNumber: "12345",
    clientNumber: "1",
    fiscalYearStart: "2026-01-01",
    accountLength: 4,
    periodStart: "2026-09-01",
    periodEnd: "2027-01-01",
    label: "Invoices",
    finalize: false,
  };
  const row = {
    businessId: "RE-1",
    entryId: "main",
    amount: "12.30",
    direction: "S",
    account: "8400",
    counterAccount: "10000",
    documentDate: "2026-09-11",
    documentNumber: "RE-1",
  };
  for (const result of [DatevHeaderSchema.safeParse(header), DatevBatchSchema.safeParse({ ...header, rows: [row] })]) {
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "periodEnd")).toBe(true);
  }
  expect(DatevHeaderSchema.safeParse({ ...header, periodEnd: "2026-09-30" }).success).toBe(true);
});

test("SEPA header validation rejects bad dates and IBANs before rendering", () => {
  const header = { destinationKey: "bank", debtorName: "Example", debtorIban: "DE89370400440532013000", executionDate: "2026-09-15" };
  expect(SepaHeaderSchema.safeParse(header).success).toBe(true);
  for (const patch of [
    { debtorIban: "DE00370400440532013000" },
    { debtorIban: "DE89 3704 0044 0532 0130 00" },
    { executionDate: "2026-02-30" },
  ]) {
    expect(SepaHeaderSchema.safeParse({ ...header, ...patch }).success).toBe(false);
  }
});

test("financial validation contracts bundle for browsers without server modules", async () => {
  const result = await Bun.build({
    entrypoints: [
      new URL("./datev-csv-contracts.ts", import.meta.url).pathname,
      new URL("./sepa-xml-contracts.ts", import.meta.url).pathname,
    ],
    target: "browser",
  });
  expect(result.success, result.logs.map(String).join("\n")).toBe(true);
  for (const output of result.outputs) {
    const source = await output.text();
    expect(source).not.toContain("libxml2-wasm");
    expect(source).not.toContain("node:crypto");
  }
});
