import { describe, expect, test } from "bun:test";

describe("public document downloads", () => {
  test("separates the public landing page from the stored artifact download", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    const download = await Bun.file(new URL("./public/documents/[token]/download.ts", import.meta.url)).text();
    const customApps = await Bun.file(new URL("../api/custom-apps.ts", import.meta.url)).text();

    expect(source).toContain('"/documents/:token/download"');
    expect(source).toContain('"/documents/:token"');
    expect(source.indexOf('"/documents/:token/download"')).toBeLessThan(source.indexOf('"/documents/:token"'));
    expect(source).toContain("publicDocumentLinkDownload(c, auditRequestContext(c))");
    expect(download).toContain("gridsService.document.getPrimaryArtifact(document, locale)");
    expect(download).toContain("documentMediaTypeAllowsPublicLinks(artifact.data.mimeType)");
    expect(download).toContain('"X-Grids-Document-Id": document.shortId');
    expect(download).toContain('"X-Grids-Document-Link-Id": link.shortId');
    expect(download).not.toContain('"X-Grids-Document-Id": document.id');
    expect(download).not.toContain('"X-Grids-Document-Link-Id": link.id');
    expect(customApps).toContain("const pdf = await getDocumentPdf(document)");
    expect(customApps).toContain('"X-Grids-Document-Artifact": "stored"');
  });
});
