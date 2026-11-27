import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import type { Document, DocumentLink } from "../../../../contracts";
import { gridsService } from "../../../../service";
import "../../../_components/ssr-test-plugin";

const { default: page } = await import("./page");

const document = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "DOC001",
  filename: "Rechnung-2026-11-0042-Werkstatt-Nordhausen-Ersatzteile-Druckluftanlage-final-v3.pdf",
  artifacts: [{ key: "pdf", filename: "rechnung.pdf", mimeType: "application/pdf" }],
  primaryArtifactKey: "pdf",
} as unknown as Document;
const link = { id: "44444444-4444-4444-8444-444444444444", expiresAt: "2026-12-02T18:00:00.000Z" } as unknown as DocumentLink;

const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    (c as unknown as { set: (key: string, value: unknown) => void }).set("runtime", { apps: [] });
    await next();
  })
  .get("/documents/:token", ...page);
const spies: Array<{ mockRestore: () => void }> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("the shared document page", () => {
  test("is never stored by caches, since it carries the link's download address", async () => {
    spies.push(spyOn(gridsService.document, "resolveDocumentLinkDownload").mockResolvedValue(ok({ link, document })));
    const response = await app.request("/documents/gdl_token");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const html = await response.text();
    expect(html).toContain('href="/share/grids/documents/gdl_token/download"');
    // the whole file name stands on the page, also where the head cuts it
    expect(html).toContain(">Rechnung-2026-11-0042-Werkstatt-Nordhausen-Ersatzteile-Druckluftanlage-final-v3.pdf<");
  });

  test("a link that is gone is not stored either", async () => {
    spies.push(spyOn(gridsService.document, "resolveDocumentLinkDownload").mockResolvedValue(fail(err.notFound("Document link"))));
    const response = await app.request("/documents/gdl_gone");
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
