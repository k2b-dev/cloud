import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;

domTest("document preview has one heading, shows the server's reason with a retry in the viewer, and aborts on close", async () => {
  const dom = createDomTestHarness();
  const { default: DocumentPreviewDialog } = await import("./DocumentPreviewDialog");
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | null | undefined;
  let requests = 0;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests++;
      requestSignal = init?.signal;
      return Response.json({ message: "Due date is missing" }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(() => <DocumentPreviewDialog entry={{ name: "Invoice", url: "/preview" }} close={() => {}} />, dom.root);
  try {
    for (let turn = 0; turn < 5; turn++) await Bun.sleep(0);
    expect(dom.root.querySelectorAll("h2")).toHaveLength(1);
    expect(dom.root.querySelector(".k2b-inline-guidance")?.textContent).toContain("Saved draft only");
    // The viewer is the one frame: its error state says why and retries; the header's close returns to the draft.
    const viewer = dom.root.querySelector(".k2b-pdf-viewer");
    expect(viewer?.getAttribute("data-state")).toBe("error");
    expect(viewer?.textContent).toContain("Due date is missing");
    expect(dom.root.querySelector("iframe")).toBeNull();
    const retry = viewer?.querySelector<HTMLButtonElement>("button");
    expect(retry?.textContent).toBe("Retry");
    retry?.click();
    for (let turn = 0; turn < 5; turn++) await Bun.sleep(0);
    expect(requests).toBe(2);
    expect(requestSignal?.aborted).toBe(false);
    dispose();
    expect(requestSignal?.aborted).toBe(true);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
