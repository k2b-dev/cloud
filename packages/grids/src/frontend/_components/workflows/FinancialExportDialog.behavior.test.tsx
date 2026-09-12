import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { FinancialExportPreview } from "../../../api/workflow-document-confirmations";

const domTest = isServer ? test.skip : test;
domTest("financial preview masks IBANs until requested and confirms the unchanged snapshot", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const iban = "DE89370400440532013000";
  const preview: FinancialExportPreview = {
    receiptId: "ABC123",
    sha256: "a".repeat(64),
    number: "SEPA-1",
    filename: "payments.xml",
    confirmedAt: null,
    warnings: [{ code: "pastExecutionDate", message: "The execution date is in the past." }],
    source: { kind: "query", capturedAt: "2026-09-11T00:00:00Z", rowCount: 1, selectionLimit: null, query: null },
    kind: "sepa-xml",
    version: 1,
    input: {
      destinationKey: "bank",
      debtorName: "Example",
      debtorIban: iban,
      executionDate: "2026-09-14",
      messageId: "message-1",
      paymentInformationId: "payment-1",
      rows: [
        {
          businessId: "expense-1",
          endToEndId: "expense-1",
          amount: "1234.50",
          creditorName: "Payee",
          creditorIban: iban,
          remittance: "Expenses",
        },
      ],
    },
  };
  let submitted: unknown;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/confirm")) {
        submitted = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        return Response.json({ confirmed: true });
      }
      return Response.json(preview);
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openFinancialExportDialog } = await import("./FinancialExportDialog");
  const { dialogCore } = await import("@k2b/ui");
  const button = (label: string) => Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim() === label);
  try {
    void openFinancialExportDialog({ runId: "RUN001", receiptId: "ABC123" });
    await Bun.sleep(80);
    expect(dom.document.body.textContent).toContain("DE •••• 3000");
    expect(dom.document.body.textContent).not.toContain(iban);
    expect(dom.document.body.textContent).toContain("1,234.50");
    expect(dom.document.body.textContent).toContain("The execution date is in the past.");
    button("Show bank details")!.click();
    expect(dom.document.body.textContent).toContain(iban);
    expect(button("Hide bank details")?.getAttribute("aria-pressed")).toBe("true");
    button("Hide bank details")!.click();
    expect(dom.document.body.textContent).not.toContain(iban);
    button("Create export file")!.click();
    await Bun.sleep(50);
    expect(submitted).toEqual({ sha256: preview.sha256 });
    expect(dom.document.body.textContent).toContain("Confirmation recorded");
    expect(preview.input.debtorIban).toBe(iban);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
