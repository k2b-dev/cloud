import { afterEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

/** Invented demo attachments of one notebook. */
const createdAt = "2026-09-01T08:00:00.000Z";
const attachment = (id: string, filename: string, mimeType: string, sizeBytes: number) => ({
  id,
  kind: mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
  filename,
  mimeType,
  sizeBytes,
  notebookId: "nb0001",
  createdBy: null,
  createdAt,
});
const attachments = [
  attachment("Att001", "Summer_party.md", "text/markdown", 120),
  attachment("Att002", "Packing_list.txt", "text/plain", 24),
  attachment("Att003", "Floor_plan.pdf", "application/pdf", 2048),
  attachment("Att004", "Stage.png", "image/png", 4096),
  attachment("Att005", "Photos.zip", "application/zip", 8192),
  attachment("Att006", "Welcome.mp3", "audio/mpeg", 4096),
  attachment("Att007", "Stands.csv", "text/csv", 25),
  attachment("Att008", "Diagram.svg", "image/svg+xml", 512),
];
const bodies: Record<string, BodyInit> = {
  Att001: "# Summer party 2026\n\nEverything the organising team needs.\n",
  Att002: "Packing list\n- Pavilion\n",
  // A spreadsheet export in Windows-1252: "Stand;Team\nGrill;Müller\n".
  Att007: new Uint8Array([...new TextEncoder().encode("Stand;Team\nGrill;M"), 0xfc, ...new TextEncoder().encode("ller\n")]),
};

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(40);
};

describe("Notebook attachment preview", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mount = async () => {
    const dom = createDomTestHarness();
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        requests.push(`${url.pathname}${url.search}`);
        const [, id, rest] = /^\/api\/notebooks\/nb0001\/attachments\/(\w+)(\/content)?$/.exec(url.pathname) ?? [];
        const meta = attachments.find((candidate) => candidate.id === id);
        if (!meta) return Promise.resolve(Response.json({ message: "Attachment not found" }, { status: 404 }));
        if (!rest) return Promise.resolve(Response.json(meta));
        if (url.searchParams.get("inline") === "true")
          return Promise.resolve(new Response("%PDF-1.7\n", { headers: { "content-type": meta.mimeType } }));
        return Promise.resolve(new Response(bodies[meta.id] ?? "", { headers: { "content-type": "application/octet-stream" } }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const { dialogCore } = await import("@k2b/ui");
    const dialog = () => dom.document.querySelector<HTMLElement>(".k2b-dialog[open]");
    const closeAll = async () => {
      while (dialogCore.isOpen()) dialogCore.close();
      await settle();
    };
    return { dom, requests, dialog, closeAll };
  };

  test("a tile opens a calm preview with the document title, the facts and the header actions", async () => {
    const { dom, requests, dialog, closeAll } = await mount();
    const { default: AttachmentsOverview } = await import("../[id]/_components/attachments-overview/AttachmentsOverview.island");
    const { render } = await import("solid-js/web");
    const dispose = render(
      () => createComponent(AttachmentsOverview, { notebookId: "nb0001", initial: attachments, searchQuery: "" }),
      dom.root,
    );
    const tile = (index: number) => dom.root.querySelectorAll<HTMLButtonElement>(".notebooks-attachment-tile__open")[index]!;
    try {
      expect(tile(0).getAttribute("aria-label")).toBe("Preview Summer_party.md");
      expect(tile(4).getAttribute("aria-label")).toBe("Download Photos.zip");
      // Audio plays only from an inline address, which the content endpoint does not serve, so it keeps the download.
      expect(tile(5).getAttribute("aria-label")).toBe("Download Welcome.mp3");

      tile(0).click();
      await settle();
      expect(dialog()?.className).toContain("notebooks-attachment-dialog--reading");
      // The leading heading becomes the title and leaves the document; the file name moves into the facts line.
      expect(dialog()?.querySelector("h2")?.textContent).toBe("Summer party 2026");
      const facts = dialog()?.querySelector(".notebooks-attachment-dialog__facts");
      expect(facts?.querySelector(".notebooks-attachment-dialog__facts-name")?.getAttribute("title")).toBe("Summer_party.md");
      expect(facts?.textContent).toContain("120 B");
      expect(facts?.hasAttribute("data-pending")).toBeFalse();
      expect(dialog()?.querySelector(".k2b-content-markdown h1")).toBeNull();
      expect(dialog()?.querySelector(".k2b-content-file-view")?.getAttribute("data-variant")).toBe("plain");
      // Download sits once in the header; Markdown has no new tab and no header Copy.
      const download = dialog()?.querySelectorAll<HTMLAnchorElement>("a[download]");
      expect(download).toHaveLength(1);
      expect(download?.[0]?.getAttribute("href")).toBe("/api/notebooks/nb0001/attachments/Att001/content?v=1");
      expect(download?.[0]?.getAttribute("download")).toBe("Summer_party.md");
      expect(dialog()?.querySelector("a[target='_blank']")).toBeNull();
      expect(dialog()?.querySelector(".k2b-panel-dialog__actions .k2b-copy-button")).toBeNull();
      await closeAll();

      // Plain text has no code box with its own Copy, so copying sits in the header.
      tile(1).click();
      await settle();
      expect(dialog()?.querySelector("h2")?.textContent).toBe("Packing_list.txt");
      expect(dialog()?.querySelector(".k2b-content-code-display__header")).toBeNull();
      expect(dialog()?.querySelector<HTMLButtonElement>(".k2b-panel-dialog__actions .k2b-copy-button")?.disabled).toBeFalse();
      await closeAll();

      // A PDF fills the wide frame, loads from the inline address and opens there in a new tab.
      tile(2).click();
      await settle();
      expect(dialog()?.className).toContain("notebooks-attachment-dialog--stretch");
      expect(dialog()?.className).not.toContain("notebooks-attachment-dialog--reading");
      expect(dialog()?.querySelector("h2")?.textContent).toBe("Floor_plan.pdf");
      const tab = dialog()?.querySelector<HTMLAnchorElement>("a[target='_blank']");
      expect(tab?.getAttribute("href")).toBe("/api/notebooks/nb0001/attachments/Att003/content?v=1&inline=true");
      expect(tab?.getAttribute("aria-label")).toBe("Open in new tab");
      expect(requests).toContain("/api/notebooks/nb0001/attachments/Att003/content?v=1&inline=true");
      expect(dialog()?.querySelector(".notebooks-attachment-dialog__pdf .k2b-content-pdf-preview__frame")).not.toBeNull();
      await closeAll();

      // An image opens in the lightbox with its name and a download.
      tile(3).click();
      await settle();
      const lightbox = dom.document.querySelector<HTMLDialogElement>("dialog.k2b-content-lightbox");
      expect(lightbox?.querySelector("img")?.getAttribute("src")).toBe("/api/notebooks/nb0001/attachments/Att004/content?v=1");
      expect(lightbox?.textContent).toContain("Stage.png");
      expect(lightbox?.querySelector("a[download]")?.getAttribute("href")).toBe("/api/notebooks/nb0001/attachments/Att004/content?v=1");
      lightbox?.querySelector<HTMLButtonElement>("button[aria-label='Close lightbox']")?.click();
      await settle();
      expect(dom.document.querySelector("dialog.k2b-content-lightbox")).toBeNull();

      // A table keeps its original bytes, so its encoding setting can read a Windows-1252 export. The header offers no
      // Copy, which could not follow that setting.
      tile(6).click();
      await settle();
      expect(dialog()?.className).toContain("notebooks-attachment-dialog--stretch");
      expect(dialog()?.querySelector(".k2b-panel-dialog__actions .k2b-copy-button")).toBeNull();
      dialog()?.querySelector<HTMLButtonElement>("button[aria-label='CSV preview settings']")?.click();
      await settle();
      const encodingSelect = [
        ...dom.document.querySelectorAll<HTMLElement>(".k2b-dialog[open] .k2b-content-file-view__settings button"),
      ].find((control) => control.closest(".k2b-field")?.textContent?.includes("Encoding"));
      expect(encodingSelect).toBeDefined();
      expect(encodingSelect?.hasAttribute("disabled")).toBeFalse();
      await closeAll();

      // A file without a preview keeps the confirmed download.
      tile(4).click();
      await settle();
      expect(dialog()?.textContent).toContain("Download “Photos.zip”?");
      await closeAll();
    } finally {
      await closeAll();
      dispose();
      dom.cleanup();
    }
  });

  test("a reference reads the stored type first and falls back to the confirmed download", async () => {
    const { dom, requests, dialog, closeAll } = await mount();
    const { openAttachmentById } = await import("./attachment-preview");
    try {
      await openAttachmentById("nb0001", "Att003", "Floor plan");
      await settle();
      expect(requests[0]).toBe("/api/notebooks/nb0001/attachments/Att003");
      expect(dialog()?.className).toContain("notebooks-attachment-dialog");
      expect(dialog()?.querySelector("h2")?.textContent).toBe("Floor_plan.pdf");
      await closeAll();

      // A reference whose attachment is gone asks to download it, as before.
      await openAttachmentById("nb0001", "Gone01", "Old plan");
      await settle();
      expect(dialog()?.textContent).toContain("Download “Old plan”?");
    } finally {
      await closeAll();
      dom.cleanup();
    }
  });

  test("only the latest reference opens, even when an earlier lookup answers after it", async () => {
    const { dom, dialog, closeAll } = await mount();
    const { openAttachmentById } = await import("./attachment-preview");
    const serve = globalThis.fetch;
    // Holds each lookup until the test answers it.
    const held: Array<{ signal: AbortSignal | null | undefined; answer: () => void }> = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) =>
          held.push({ signal: init?.signal, answer: () => void serve(input, init).then(resolve, reject) }),
        ),
      { preconnect: serve.preconnect },
    );
    try {
      const first = openAttachmentById("nb0001", "Att002", "Packing list");
      const second = openAttachmentById("nb0001", "Att003", "Floor plan");
      expect(held).toHaveLength(2);
      // The earlier lookup is cancelled, so it opens nothing even when it answers last.
      expect(held[0]!.signal?.aborted).toBeTrue();
      globalThis.fetch = serve;
      held[1]!.answer();
      await second;
      held[0]!.answer();
      await first;
      await settle();
      expect(dom.document.querySelectorAll(".k2b-dialog[open]")).toHaveLength(1);
      expect(dialog()?.querySelector("h2")?.textContent).toBe("Floor_plan.pdf");
    } finally {
      globalThis.fetch = serve;
      await closeAll();
      dom.cleanup();
    }
  });

  test("an attached image opens in the lightbox once shown, and reads its stored type when it could not be shown", async () => {
    const { dom, requests, dialog, closeAll } = await mount();
    const { openAttachedImage } = await import("./attachment-preview");
    const image = (naturalWidth: number) => {
      const element = dom.document.createElement("img");
      Object.defineProperties(element, { complete: { value: true }, naturalWidth: { value: naturalWidth } });
      return element;
    };
    try {
      // The content endpoint serves an SVG only as a download, so the note shows no image and it asks to download.
      openAttachedImage(image(0), "nb0001", "Att008", "Diagram");
      await settle();
      expect(requests).toEqual(["/api/notebooks/nb0001/attachments/Att008"]);
      expect(dom.document.querySelector("dialog.k2b-content-lightbox")).toBeNull();
      expect(dialog()?.textContent).toContain("Download “Diagram.svg”?");
      await closeAll();

      openAttachedImage(image(640), "nb0001", "Att004", "Stage");
      await settle();
      const lightbox = dom.document.querySelector<HTMLDialogElement>("dialog.k2b-content-lightbox");
      expect(lightbox?.querySelector("img")?.getAttribute("src")).toBe("/api/notebooks/nb0001/attachments/Att004/content?v=1");
      expect(lightbox?.textContent).toContain("Stage");
      expect(requests).toHaveLength(1);
    } finally {
      await closeAll();
      dom.cleanup();
    }
  });
});
