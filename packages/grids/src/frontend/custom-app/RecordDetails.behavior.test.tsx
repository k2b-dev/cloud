import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("closing a draft preview aborts its request and leaves no error dialog", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | null | undefined;
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }, { preconnect: originalFetch.preconnect });
  const { default: RecordDetails } = await import("./RecordDetails.island");
  const { dialogCore } = await import("@k2b/ui");
  const timestamp = "2026-09-14T12:00:00.000Z";
  const dispose = render(() => <RecordDetails
    block={{ id: "record", type: "record", fieldIds: ["FIELD1"], editableFieldIds: [], documents: { templateIds: ["DOC001"], preview: true } }}
    baseId="BASE01" tableName="Draft" auditPolicy={{}}
    record={{ id: "REC001", tableId: "TABLE1", data: { FIELD1: "Draft invoice" }, version: 1, deletedAt: null, createdBy: null, updatedBy: null, createdAt: timestamp, updatedAt: timestamp }}
    fields={[{ id: "FIELD1", tableId: "TABLE1", name: "Subject", description: null, type: "text", config: {}, position: 0, required: false, presentable: true,
      hideInTable: false, defaultValue: null, indexed: false, uniqueConstraint: false, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }]}
    relationLabels={{}} fileEndpoints={{}} filesByField={{}} documents={[]}
    documentPreviews={[{ name: "Invoice", url: "/preview" }]} dateConfig={{ timeZone: "Europe/Berlin" }}
  />, dom.root);
  const button = (text: string) => Array.from(dom.document.querySelectorAll("button")).find((entry) => entry.textContent?.includes(text));
  try {
    const open = button("Invoice");
    expect(open).toBeDefined();
    open!.click();
    await Bun.sleep(10);
    const generate = button("Render preview");
    expect(generate).toBeDefined();
    generate!.click();
    await Bun.sleep(10);
    expect(requestSignal).toBeDefined();
    expect(requestSignal?.aborted).toBe(false);
    dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await Bun.sleep(20);
    expect(requestSignal?.aborted).toBe(true);
    expect(dialogCore.isOpen()).toBe(false);
    expect(dom.document.body.textContent).not.toContain("Aborted");
  } finally {
    dialogCore.close();
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
