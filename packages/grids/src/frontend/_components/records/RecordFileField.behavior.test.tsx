import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField, PublicGridFile } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;

const field: PublicField = {
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Cover",
  description: null,
  type: "file",
  config: { maxFiles: 2 },
  position: 0,
  required: false,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
};
const stored = (filename: string): PublicGridFile => ({
  id: "FILE01",
  recordId: "RECORD",
  fieldId: field.id,
  position: 0,
  filename,
  mimeType: "image/png",
  sizeBytes: 10,
  sha256: "",
  createdBy: null,
  createdAt: "2026-10-08T00:00:00Z",
});

/** A drop of files from outside the page, as an engine dispatches it. */
const dropEvent = (dom: DomTestHarness, names: string[]) => {
  const event = new dom.window.Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
  const files = names.map((name) => new File([new Uint8Array(10)], name, { type: "image/png" }));
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, items: files.map((file) => ({ kind: "file", type: file.type })), dropEffect: "none" },
  });
  return event;
};

domTest("a file field takes only as many dropped files as it has room for and names the rest once", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const attached = [stored("front.png")];
  let uploads = 0;
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST" && init.body instanceof FormData) {
        uploads++;
        const file = init.body.get("file");
        attached.push(stored(file instanceof File ? file.name : "?"));
        return Response.json({});
      }
      return Response.json({ items: attached });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: RecordFileField } = await import("./RecordFileField");
  const dispose = render(
    () => (
      <RecordFileField
        tableId="TABLE1"
        recordId="RECORD1"
        field={field}
        canWrite
        initialFiles={[...attached]}
        endpoint="/api/files/FIELD1"
      />
    ),
    dom.root,
  );
  try {
    await Bun.sleep(0);
    const root = dom.root.firstElementChild!;
    root.dispatchEvent(dropEvent(dom, ["back.png", "side.png", "top.png"]));
    await Bun.sleep(30);
    expect(uploads).toBe(1);
    expect(attached.map((file) => file.filename)).toEqual(["front.png", "back.png"]);
    expect(dom.document.body.textContent).toContain("Only one file at a time. Not added: side.png, top.png");

    // A full field takes no more drops.
    const full = dropEvent(dom, ["more.png"]);
    root.dispatchEvent(full);
    await Bun.sleep(30);
    expect(full.defaultPrevented).toBe(true);
    expect(uploads).toBe(1);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
