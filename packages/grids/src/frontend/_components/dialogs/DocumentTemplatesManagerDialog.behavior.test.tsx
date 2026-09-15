import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

for (const issuancePolicy of ["repeatable", "oncePerFinalizedRecord"] as const) {
  domTest(`duplicating a ${issuancePolicy} template preserves its policy and starts disabled`, async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const requests: unknown[] = [];
    const template = {
      id: "TMPL01", tableId: "TABLE1", name: "Receipt", description: null,
      source: "from table {TABLE1}", renderer: { kind: "html", body: "<p>Receipt</p>" },
      issuancePolicy, enabled: true, position: 0,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ ...template, id: "TMPL02" });
      }
      return Response.json([template]);
    }, { preconnect: originalFetch.preconnect });
    const { openDocumentTemplatesDialog } = await import("./DocumentTemplatesManagerDialog");
    const { dialogCore } = await import("@k2b/ui");
    try {
      void openDocumentTemplatesDialog({ baseId: "BASE01", tableId: "TABLE1", tableName: "Receipts" });
      await Bun.sleep(25);
      const duplicate = dom.document.querySelector<HTMLButtonElement>('button[aria-label="Duplicate template"]');
      expect(duplicate).not.toBeNull();
      duplicate!.click();
      await Bun.sleep(25);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ issuancePolicy, enabled: false, source: template.source, renderer: template.renderer });
    } finally {
      dialogCore.close();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
}
