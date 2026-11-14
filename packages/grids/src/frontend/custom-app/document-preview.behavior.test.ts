import { afterEach, expect, spyOn, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const messages = {
  previewDraftMeta: "Saved draft · no document issued",
  previewDocumentFailed: "The preview could not be created.",
  previewOpenInTab: "Open in new tab",
};

domTest("a draft preview renders on request, names the server's reason when refused, and stops when the Lightbox closes", async () => {
  const dom = createDomTestHarness();
  const { documentPreviewItem } = await import("./document-preview");
  const { toast } = await import("@k2b/ui");
  const error = spyOn(toast, "error");
  const requests: { method?: string; signal?: AbortSignal | null }[] = [];
  let answer: () => Response = () => Response.json({ message: "Due date is missing" }, { status: 400 });
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ method: init?.method, signal: init?.signal });
      return answer();
    },
    { preconnect: originalFetch.preconnect },
  );
  const controller = new AbortController();
  try {
    const item = documentPreviewItem({ name: "Invoice", url: "/preview" }, messages, controller.signal);
    // The draft note sits in the facts, and the item is a PDF the Lightbox loads; nothing is read before it shows.
    expect(item).toMatchObject({ name: "Invoice", meta: messages.previewDraftMeta, file: { mediaType: "application/pdf" } });
    expect(requests).toHaveLength(0);
    await expect(item.load!(new AbortController().signal)).rejects.toThrow("Due date is missing");
    expect(error.mock.calls.map(([message]) => message)).toEqual(["Due date is missing"]);
    expect(requests[0]).toMatchObject({ method: "POST" });

    // "Try again" in the Lightbox loads anew; the PDF arrives as its bytes.
    answer = () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    const shown = new AbortController();
    const content = await item.load!(shown.signal);
    expect(content).toEqual({ encoding: "base64", content: btoa("%PDF-1.7"), mediaType: "application/pdf" });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.signal?.aborted).toBe(false);
    // The rendered PDF opens in a tab, as the preview dialog offered, for example to print it.
    const opened: (string | URL | undefined)[] = [];
    const open = spyOn(window, "open").mockImplementation((url) => {
      opened.push(url);
      return null;
    });
    item.actions?.find((action) => action.label === "Open in new tab")?.onClick();
    expect(opened).toHaveLength(1);
    open.mockRestore();
    // Moving on in the Lightbox, or closing the page, stops a render that still runs.
    shown.abort();
    expect(requests[1]?.signal?.aborted).toBe(true);
    controller.abort();
  } finally {
    error.mockRestore();
    dom.cleanup();
  }
});
