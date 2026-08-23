import { describe, expect, test } from "bun:test";

describe("public document downloads", () => {
  test("separates the public landing page from the stored artifact download", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
    const customApps = await Bun.file(new URL("../api/custom-apps.ts", import.meta.url)).text();

    expect(source).toContain('"/documents/:token/download"');
    expect(source).toContain('"/documents/:token"');
    expect(source.indexOf('"/documents/:token/download"')).toBeLessThan(source.indexOf('"/documents/:token"'));
    expect(source).toContain("gridsService.document.getPdf(resolved.data.document)");
    expect(source).toContain('"X-Grids-Document-Id": resolved.data.document.shortId');
    expect(source).toContain('"X-Grids-Document-Link-Id": resolved.data.link.shortId');
    expect(source).not.toContain('"X-Grids-Document-Id": resolved.data.document.id');
    expect(source).not.toContain('"X-Grids-Document-Link-Id": resolved.data.link.id');
    expect(customApps).toContain("const pdf = await getDocumentPdf(document)");
    expect(customApps).toContain('"X-Grids-Document-Artifact": "stored"');
  });
});
