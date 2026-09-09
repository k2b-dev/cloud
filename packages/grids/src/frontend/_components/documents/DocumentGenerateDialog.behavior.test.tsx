import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("generation blocks dismissal while pending and preserves the key after an uncertain response", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ idempotencyKey: string }> = [];
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/preview-pdf")) return new Response("%PDF", { headers: { "content-type": "application/pdf" } });
      if (String(input).endsWith("/generate")) {
        requests.push(JSON.parse(String(init?.body)));
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Response.json({ items: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentGenerateDialog } = await import("./DocumentGenerateDialog");
  const { dialogCore } = await import("@k2b/ui");
  const button = (label: string) => Array.from(dom.document.querySelectorAll("button")).find((item) => item.textContent?.trim() === label)!;
  try {
    void openDocumentGenerateDialog({
      table: { id: "TABLE1", name: "Loans" },
      initialRecordId: "RECORD",
      onGenerated: () => {},
      template: {
        id: "TMPL01",
        tableId: "TABLE1",
        name: "Loan PDF",
        description: null,
        renderer: { kind: "html" },
        enabled: true,
        position: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    button("Render preview").click();
    await Bun.sleep(15);
    button("Generate Document").click();
    await Bun.sleep(5);
    expect(requests).toHaveLength(1);
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(5);
    expect(dialogCore.isOpen()).toBe(true);
    expect(dom.document.body.textContent).toContain("Keep this dialog open");
    finish!(Response.json({ message: "Connection interrupted" }, { status: 503 }));
    await Bun.sleep(15);
    expect(dom.document.body.textContent).toContain("Connection interrupted");
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(5);
    expect(dom.document.body.textContent).toContain("The document may already have been created");
    const cancel = Array.from(dom.document.querySelectorAll("button")).filter((item) => item.textContent?.trim() === "Cancel");
    cancel.at(-1)!.click();
    await Bun.sleep(5);
    button("Retry generation").click();
    await Bun.sleep(5);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.idempotencyKey).toBe(requests[0]?.idempotencyKey);
    finish!(Response.json({ message: "Still unavailable" }, { status: 503 }));
    await Bun.sleep(5);
  } finally {
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
