import { describe, expect, test } from "bun:test";
import { documentMessages } from "./messages";

describe("document generation dialog", () => {
  test("uses editable tags, clear guidance, and a tall fixed preview workspace", async () => {
    const source = await Bun.file(new URL("./DocumentGenerateDialog.tsx", import.meta.url)).text();
    const copy = documentMessages.resolve(["en"]).t;

    expect(source).toContain("panelDialogFixedOptions");
    expect(source).toContain("is-wide");
    expect(copy.recordDescription).toBe("Choose the record whose current data should be used for this Document.");
    expect(copy.tagsDescription).toBe("Optional labels for finding and organizing the generated document.");
    expect(copy.immutableGeneratedDocument).toBe("The generated Document stays unchanged");
    expect(copy.immutableGeneratedDocumentDetail).toContain("Generate again to create a new Document.");
    expect(source).toContain("min-h-[36rem]");
    expect(source).not.toContain("recursive snapshot");
    expect(source).not.toContain("Liquid filename pattern");
  });
});

describe("document link dialog", () => {
  test("uses NoticeCard's semantic content contract for persistent guidance", async () => {
    const source = await Bun.file(new URL("./DocumentLinkDialog.tsx", import.meta.url)).text();

    expect(source).toContain("title={t().anyoneCanDownload}");
    expect(documentMessages.resolve(["de-CH"]).t.anyoneCanDownload).toBe("Jede Person mit dem Link kann dieses PDF herunterladen");
    expect(source).toContain('tone="success"');
    expect(source).not.toContain('<NoticeCard tone="info" icon={false}>');
    expect(source).not.toContain('<NoticeCard tone="success" icon={false}>');
  });
});
