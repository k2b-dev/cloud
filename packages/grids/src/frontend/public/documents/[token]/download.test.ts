import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import type { Document, DocumentLink } from "../../../../contracts";
import { gridsService } from "../../../../service";
import { publicDocumentLinkDownload } from "./download";

const artifact = (key: string, filename: string, mimeType: string) => ({
  key,
  fileId: "11111111-1111-4111-8111-111111111111",
  filename,
  mimeType,
  sizeBytes: 5,
  sha256: "a".repeat(64),
});
const document = (primary: ReturnType<typeof artifact>): Document =>
  ({
    id: "22222222-2222-4222-8222-222222222222",
    shortId: "DOC001",
    baseId: "33333333-3333-4333-8333-333333333333",
    tableId: null,
    recordId: null,
    templateId: null,
    filename: primary.filename,
    artifacts: [primary, artifact("pdf", "copy.pdf", "application/pdf")],
    primaryArtifactKey: primary.key,
  }) as unknown as Document;
const link = { id: "44444444-4444-4444-8444-444444444444", shortId: "LNK001" } as DocumentLink;
const app = new Hono<AuthContext>().get("/documents/:token/download", (c) => publicDocumentLinkDownload(c, {}));
const download = () => app.request("/documents/gdl_token/download");
const spies: Array<{ mockRestore: () => void }> = [];
const arrange = (primary: ReturnType<typeof artifact>, bytes = "a,b\n1,2") => {
  spies.push(
    spyOn(gridsService.document, "resolveDocumentLinkDownload").mockResolvedValue(ok({ link, document: document(primary) })),
    spyOn(gridsService.document, "getPrimaryArtifact").mockResolvedValue(ok({ ...primary, bytes: new TextEncoder().encode(bytes) })),
    spyOn(gridsService.document, "recordDocumentLinkAccess").mockResolvedValue(ok(link)),
  );
};

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

describe("public document link download", () => {
  test("serves a non-PDF primary artifact as a nosniff attachment with its stored type", async () => {
    arrange(artifact("csv", "payments 2026.csv", "text/csv"));
    const response = await download();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="payments 2026.csv"; filename*=UTF-8''payments%202026.csv`,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Grids-Document-Artifact")).toBe("csv");
    expect(response.headers.get("X-Grids-Document-Link-Id")).toBe("LNK001");
    expect(await response.text()).toBe("a,b\n1,2");
    expect(gridsService.document.recordDocumentLinkAccess).toHaveBeenCalledTimes(1);
  });

  test("never serves stored bytes outside the allow-list, even when a link resolves", async () => {
    arrange(artifact("page", "invoice.html", "text/html"), "<script>alert(1)</script>");
    const response = await download();
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(gridsService.document.recordDocumentLinkAccess).not.toHaveBeenCalled();
  });

  test("hides unknown, expired and revoked links behind one not-found answer", async () => {
    spies.push(
      spyOn(gridsService.document, "resolveDocumentLinkDownload").mockResolvedValue(fail(err.notFound("Document link"))),
      spyOn(gridsService.document, "getPrimaryArtifact"),
    );
    const response = await download();
    expect(response.status).toBe(404);
    expect(gridsService.document.getPrimaryArtifact).not.toHaveBeenCalled();
  });
});
