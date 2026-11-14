import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
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

  let dom: ReturnType<typeof createDomTestHarness>;
  const loadModules = async () => {
    const { dialogCore } = await import("@k2b/ui");
    const { default: AttachmentsOverview } = await import("../[id]/_components/attachments-overview/AttachmentsOverview.island");
    const { openAttachmentById } = await import("./attachment-preview");
    return { dialogCore, AttachmentsOverview, openAttachmentById };
  };
  let modules: Awaited<ReturnType<typeof loadModules>>;
  beforeAll(async () => {
    // Delegated Solid handlers belong to the document used while modules load.
    dom = createDomTestHarness();
    modules = await loadModules();
  });
  afterAll(() => dom?.cleanup());

  const originalFetch = globalThis.fetch;
  const closeAll = async () => {
    while (modules.dialogCore.isOpen()) modules.dialogCore.close();
    for (const button of dom.document.querySelectorAll<HTMLButtonElement>("dialog.k2b-lightbox button[aria-label='Close']")) button.click();
    await settle();
  };
  afterEach(async () => {
    try {
      await closeAll();
    } finally {
      globalThis.fetch = originalFetch;
      dom.root.replaceChildren();
    }
  });

  const mount = async () => {
    const requests: string[] = [];
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
        // Only the notebook's own requests count: the page's file-provider discovery asks the catalog once idle,
        // at a moment no test controls.
        if (url.pathname.startsWith("/api/notebooks/")) requests.push(`${url.pathname}${url.search}`);
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
    const dialog = () => dom.document.querySelector<HTMLElement>(".k2b-dialog[open]");
    const lightbox = () => dom.document.querySelector<HTMLDialogElement>("dialog.k2b-lightbox");
    return { dom, requests, dialog, lightbox, closeAll };
  };

  test("a tile opens the Lightbox with the document title, the facts and the dialog's former actions", async () => {
    const { dom, requests, dialog, lightbox, closeAll } = await mount();
    const { AttachmentsOverview } = modules;
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

      const actions = () => [...(lightbox()?.querySelectorAll(".k2b-lightbox__action") ?? [])].map((button) => button.textContent);
      tile(0).click();
      await settle();
      // The leading heading becomes the name and leaves the document; the file name moves into the facts.
      expect(lightbox()?.getAttribute("aria-label")).toBe("Summer party 2026");
      const facts = lightbox()?.querySelector(".k2b-lightbox__name span")?.textContent;
      expect(facts).toContain("Summer_party.md");
      expect(facts).toContain("120 B");
      expect(lightbox()?.querySelector(".k2b-content-markdown h1")).toBeNull();
      expect(lightbox()?.querySelector(".k2b-content-file-view")?.getAttribute("data-variant")).toBe("plain");
      // Save to Files and Download sit once in the action pill; Markdown has its own copy, so no Copy text.
      const download = lightbox()?.querySelectorAll<HTMLAnchorElement>(".k2b-lightbox__actions a[download]");
      expect(download).toHaveLength(1);
      expect(download?.[0]?.getAttribute("href")).toBe("/api/notebooks/nb0001/attachments/Att001/content?v=1");
      expect(actions()).toEqual(["Save to…"]);
      // Every attachment of the list is in the strip; the arrow key steps on to the plain text.
      expect(lightbox()?.querySelectorAll(".k2b-thumbnail-strip__thumb")).toHaveLength(attachments.length);
      dom.document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      await settle();
      // Plain text has no code box with its own Copy, so Copy text sits in the action pill.
      expect(lightbox()?.getAttribute("aria-label")).toBe("Packing_list.txt");
      expect(lightbox()?.querySelector(".k2b-content-code-display__header")).toBeNull();
      expect(actions()).toEqual(["Copy text", "Save to…"]);
      await closeAll();

      // A PDF loads from the inline address, which also opens in a new tab.
      tile(2).click();
      await settle();
      expect(lightbox()?.getAttribute("aria-label")).toBe("Floor_plan.pdf");
      expect(actions()).toEqual(["Open in new tab", "Save to…"]);
      expect(requests).toContain("/api/notebooks/nb0001/attachments/Att003/content?v=1&inline=true");
      // pdf.js cannot draw this stub here; the Lightbox then offers Try again and Download in its place.
      expect(lightbox()?.querySelector(".k2b-pdf-viewer, .k2b-lightbox__notice a[download]")).not.toBeNull();
      await closeAll();

      // An image shows with its name and a download.
      tile(3).click();
      await settle();
      expect(lightbox()?.querySelector("img.k2b-lightbox__image")?.getAttribute("src")).toBe(
        "/api/notebooks/nb0001/attachments/Att004/content?v=1",
      );
      expect(lightbox()?.getAttribute("aria-label")).toBe("Stage.png");
      await closeAll();
      expect(lightbox()).toBeNull();

      // A table keeps its original bytes, so its encoding setting can read a Windows-1252 export. The pill offers no
      // Copy text, which could not follow that setting.
      tile(6).click();
      await settle();
      expect(actions()).toEqual(["Save to…"]);
      lightbox()?.querySelector<HTMLButtonElement>("button[aria-label='CSV preview settings']")?.click();
      await settle();
      const encodingSelect = [...dom.document.querySelectorAll<HTMLElement>(".k2b-content-file-view__settings button")].find((control) =>
        control.closest(".k2b-field")?.textContent?.includes("Encoding"),
      );
      expect(encodingSelect).toBeDefined();
      expect(encodingSelect?.hasAttribute("disabled")).toBeFalse();
      await closeAll();

      // A file without a preview, clicked on its own, keeps the confirmed download.
      tile(4).click();
      await settle();
      expect(lightbox()).toBeNull();
      expect(dialog()?.textContent).toContain("Download “Photos.zip”?");
      await closeAll();
    } finally {
      try {
        await closeAll();
      } finally {
        dispose();
      }
    }
  });

  test("a reference reads the stored type first and falls back to the confirmed download", async () => {
    const { requests, dialog, lightbox, closeAll } = await mount();
    const { openAttachmentById } = modules;
    try {
      await openAttachmentById("nb0001", "Att003", "Floor plan");
      await settle();
      expect(requests[0]).toBe("/api/notebooks/nb0001/attachments/Att003");
      expect(lightbox()?.getAttribute("aria-label")).toBe("Floor_plan.pdf");
      // A reference opens its own attachment only, without a strip.
      expect(lightbox()?.querySelector(".k2b-thumbnail-strip")).toBeNull();
      await closeAll();

      // An image the note shows reads its stored type too and opens in the Lightbox; an SVG the content endpoint
      // serves only as a download asks to download it.
      await openAttachmentById("nb0001", "Att004", "Stage");
      await settle();
      expect(lightbox()?.querySelector("img.k2b-lightbox__image")?.getAttribute("src")).toBe(
        "/api/notebooks/nb0001/attachments/Att004/content?v=1",
      );
      await closeAll();
      await openAttachmentById("nb0001", "Att008", "Diagram");
      await settle();
      expect(lightbox()).toBeNull();
      expect(dialog()?.textContent).toContain("Download “Diagram.svg”?");
      await closeAll();

      // A reference whose attachment is gone asks to download it, as before.
      await openAttachmentById("nb0001", "Gone01", "Old plan");
      await settle();
      expect(dialog()?.textContent).toContain("Download “Old plan”?");
    } finally {
      await closeAll();
    }
  });

  test("only the latest reference opens, even when an earlier lookup answers after it", async () => {
    const { dom, lightbox, closeAll } = await mount();
    const { openAttachmentById } = modules;
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
      expect(dom.document.querySelectorAll("dialog.k2b-lightbox")).toHaveLength(1);
      expect(lightbox()?.getAttribute("aria-label")).toBe("Floor_plan.pdf");
    } finally {
      globalThis.fetch = serve;
      await closeAll();
    }
  });
});
