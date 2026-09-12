import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { FinancialWorkflowStarter, financialStarterMessages } = await import("./FinancialWorkflowStarter");

test("payment starter first asks for source fields, not banking details", () => {
  const html = renderToString(() =>
    createComponent(FinancialWorkflowStarter, {
      kind: "expensePayment",
      tables: [],
      fieldsByTable: {},
      onDirty: () => {},
      onComplete: () => {},
    }),
  );
  expect(html).toContain("Unique reimbursement number");
  expect(html).toContain("Amount in EUR");
  expect(html).toContain("Configure destination");
  expect(html).not.toContain("Sender IBAN");
  expect(html).toContain("disabled");
});

test("invoice starter explains snapshot prerequisites and asks for explicit direction", () => {
  const html = renderToString(() =>
    createComponent(FinancialWorkflowStarter, {
      kind: "invoiceAccounting",
      tables: [],
      fieldsByTable: {},
      onDirty: () => {},
      onComplete: () => {},
    }),
  );
  expect(html).toContain("Booking direction (S / H)");
  expect(html).toContain("No live amounts are recalculated");
  expect(html).not.toContain("Unique reimbursement number");
  expect(financialStarterMessages.resolve(["de"]).t.unfinished).toContain("Finalisiere");
});
