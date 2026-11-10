import { expect, test } from "bun:test";
import { blockDiagnostic } from "./block-messages";

test("balance-flow diagnostics name the offending period in both Notes locales", () => {
  const diagnostic = { code: "chart-balance-period" as const, line: 1, path: "periods.0", params: { name: "October 2026" } };
  expect(blockDiagnostic("en", diagnostic)).toContain("Check the amounts for October 2026");
  expect(blockDiagnostic("de", diagnostic)).toContain("Beträge für October 2026 prüfen");
});
