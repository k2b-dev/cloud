import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("document preview has one heading, header actions, actionable errors and aborts on close", async () => {
  const dom = createDomTestHarness();
  const { default: DocumentPreviewDialog } = await import("./DocumentPreviewDialog");
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | null | undefined;
  let closes = 0;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal;
      return Response.json({ message: "Due date is missing" }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(() => <DocumentPreviewDialog entry={{ name: "Invoice", url: "/preview" }} close={() => closes++} />, dom.root);
  try {
    await Bun.sleep(0);
    expect(dom.root.querySelectorAll("h2")).toHaveLength(1);
    expect(dom.root.querySelectorAll("header .k2b-content-pdf-preview__actions button")).toHaveLength(2);
    expect(dom.root.querySelector(".k2b-content-pdf-preview")).toBeNull();
    expect(dom.root.querySelector(".k2b-inline-guidance")?.textContent).toContain("Saved draft only");
    const error = dom.root.querySelector('[role="alert"]');
    expect(error?.textContent).toContain("Preview is not available yet");
    expect(error?.textContent).toContain("Due date is missing");
    expect(dom.root.querySelector("iframe")).toBeNull();
    const back = error?.querySelector("button");
    expect(back?.textContent).toContain("Back to draft");
    back?.click();
    expect(closes).toBe(1);
    expect(requestSignal?.aborted).toBe(false);
    dispose();
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
