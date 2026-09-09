import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
domTest("a newly created link explains that it cannot be displayed again", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        url: "/share/grids/documents/test-only",
        link: { id: "LINK01" },
      }),
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentLinkDialog } = await import("./DocumentLinkDialog");
  try {
    void openDocumentLinkDialog({
      onCreated: () => {},
      document: {
        id: "DOC001",
        baseId: "BASE01",
        tableId: "TABLE1",
        templateId: "TMPL01",
        recordId: "RECORD",
        number: "Demo",
        filename: "demo.pdf",
        createdAt: new Date().toISOString(),
        createdBy: null,
        tags: [],
        renderer: { kind: "html" },
        validationStatus: null,
        artifacts: [],
      },
    });
    const create = Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim() === "Create link");
    create!.click();
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("This link is shown only now");
    expect(dom.document.body.textContent).toContain("You cannot view it again afterwards");
    expect(dom.document.body.textContent).toContain("test-only");
  } finally {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("subdialogs preserve the document dialog and share its link read", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let linkReads = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      if (!String(input).includes("links")) return Response.json({}, { status: 403 });
      linkReads++;
      return Response.json({ items: [] });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentDetailsDialog } = await import("./DocumentDetailsDialog");
  const button = (text: string) =>
    Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim().startsWith(text));
  try {
    void openDocumentDetailsDialog({
      canWrite: true,
      onDownload: () => {},
      document: {
        id: "DOC001",
        baseId: "BASE01",
        tableId: "TABLE1",
        templateId: "TMPL01",
        recordId: "RECORD",
        number: "Demo invoice",
        filename: "invoice.pdf",
        createdAt: "2026-09-09T12:00:00Z",
        createdBy: null,
        tags: [],
        renderer: { kind: "html" },
        validationStatus: null,
        artifacts: [{ key: "pdf", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1024, sha256: "a".repeat(64) }],
      },
    });
    await Bun.sleep(30);
    expect(linkReads).toBe(1);
    expect(dom.document.body.textContent).toContain("No active links");
    expect(dom.document.body.textContent).toContain("Source record unavailable");
    expect(dom.document.querySelector('a[href*="?record="]')).toBeNull();
    button("Technical details")!.click();
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("SHA-256");
    expect(button("Download PDF")).toBeDefined();
    expect(linkReads).toBe(1);
    button("Close")!.click();
    await Bun.sleep(30);
    button("Share links")!.click();
    await Bun.sleep(30);
    expect(linkReads).toBe(2);
    expect(dom.document.body.textContent).toContain("No active links");
    expect(dom.document.body.textContent).not.toContain("This link is shown only now");
    expect(button("Download PDF")).toBeDefined();
    button("Close")!.click();
  } finally {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("read-only details resolve the source name without loading share links", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let linkReads = 0;
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      paths.push(url);
      if (url.includes("links")) {
        linkReads++;
        return Response.json({ items: [] });
      }
      if (url.includes("fields")) return Response.json([{ id: "FIELD1", type: "text", config: {}, presentable: true, deletedAt: null }]);
      return Response.json({ id: "RECORD", data: { FIELD1: "Equipment loan 101" } });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentDetailsDialog } = await import("./DocumentDetailsDialog");
  try {
    void openDocumentDetailsDialog({
      canWrite: false,
      onDownload: () => {},
      document: {
        id: "DOC001",
        baseId: "BASE01",
        tableId: "TABLE1",
        templateId: "TMPL01",
        recordId: "RECORD",
        number: "Demo",
        filename: "demo.pdf",
        createdAt: new Date().toISOString(),
        createdBy: null,
        tags: [],
        renderer: { kind: "html" },
        validationStatus: null,
        artifacts: [],
      },
    });
    await Bun.sleep(100);
    expect(linkReads).toBe(0);
    expect(paths.some((path) => path.includes("fields"))).toBe(true);
    expect(dom.document.querySelector('a[href*="?record="]')?.textContent).toContain("Equipment loan 101");
    expect(dom.document.body.textContent).not.toContain("Share links");
  } finally {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("link summary is honest during loading and errors, then follows revocation", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  let respond: ((response: Response) => void) | undefined;
  let revoked = false;
  let reads = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("links")) return Response.json({}, { status: 404 });
      if (url.includes("revoke")) {
        revoked = true;
        return Response.json({});
      }
      reads++;
      if (reads === 1)
        return new Promise<Response>((resolve) => {
          respond = resolve;
        });
      return Response.json({
        items: [
          {
            id: "LINK01",
            documentId: "DOC001",
            baseId: "BASE01",
            comment: null,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            revokedAt: revoked ? new Date().toISOString() : null,
            accessCount: 0,
            lastAccessedAt: null,
          },
        ],
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { openDocumentDetailsDialog } = await import("./DocumentDetailsDialog");
  const button = (text: string) =>
    Array.from(dom.document.querySelectorAll("button")).find((node) => node.textContent?.trim().startsWith(text));
  try {
    void openDocumentDetailsDialog({
      canWrite: true,
      onDownload: () => {},
      document: {
        id: "DOC001",
        baseId: "BASE01",
        tableId: "TABLE1",
        templateId: "TMPL01",
        recordId: "RECORD",
        number: "Demo",
        filename: "demo.pdf",
        createdAt: new Date().toISOString(),
        createdBy: null,
        tags: [],
        renderer: { kind: "html" },
        validationStatus: null,
        artifacts: [],
      },
    });
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Loading links");
    expect(dom.document.body.textContent).not.toContain("No active links");
    respond!(Response.json({ message: "unavailable" }, { status: 503 }));
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("Could not load links");
    expect(dom.document.body.textContent).not.toContain("No active links");
    button("Share links")!.click();
    await Bun.sleep(30);
    expect(dom.document.body.textContent).toContain("1 active link");
    dom.document.querySelector<HTMLButtonElement>('button[aria-label="Revoke link"]')!.click();
    await Bun.sleep(30);
    expect(revoked).toBe(false);
    expect(dom.document.body.textContent).toContain("This cannot be undone");
    button("Cancel")!.click();
    await Bun.sleep(30);
    expect(revoked).toBe(false);
    dom.document.querySelector<HTMLButtonElement>('button[aria-label="Revoke link"]')!.click();
    await Bun.sleep(30);
    button("Revoke link")!.click();
    await Bun.sleep(30);
    expect(revoked).toBe(true);
    expect(dom.document.body.textContent).toContain("No active links");
    expect(dom.document.body.textContent).toContain("Revoked");
    button("Close")!.click();
    expect(dom.document.body.textContent).toContain("No active links");
  } finally {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
