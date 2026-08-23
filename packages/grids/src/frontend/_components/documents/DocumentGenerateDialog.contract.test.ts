import { describe, expect, test } from "bun:test";

describe("document generation dialog", () => {
  test("uses editable tags, clear guidance, and a tall fixed preview workspace", async () => {
    const source = await Bun.file(new URL("./DocumentGenerateDialog.tsx", import.meta.url)).text();

    expect(source).toContain("panelDialogFixedOptions");
    expect(source).toContain("is-wide");
    expect(source).toContain("Choose the record whose current data should be used for this Document.");
    expect(source).toContain("Optional labels for finding and organizing the generated document.");
    expect(source).toContain('title="The generated Document stays unchanged"');
    expect(source).toContain("Generate again to create a new Document.");
    expect(source).toContain("min-h-[36rem]");
    expect(source).not.toContain("recursive snapshot");
    expect(source).not.toContain("Liquid filename pattern");
  });
});

describe("document link dialog", () => {
  test("uses NoticeCard's semantic content contract for persistent guidance", async () => {
    const source = await Bun.file(new URL("./DocumentLinkDialog.tsx", import.meta.url)).text();

    expect(source).toContain('title="Anyone with the link can download this PDF"');
    expect(source).toContain('tone="success"');
    expect(source).not.toContain('<NoticeCard tone="info" icon={false}>');
    expect(source).not.toContain('<NoticeCard tone="success" icon={false}>');
  });
});
