import { describe, expect, test } from "bun:test";

describe("App record details", () => {
  test("uses shared detail semantics and typed field rendering", async () => {
    const source = await Bun.file(new URL("./RecordDetails.island.tsx", import.meta.url)).text();

    expect(source).toContain("DescriptionList");
    expect(source).toContain("PanelHeader");
    expect(source).toContain("<FieldValue");
    expect(source).toContain('mode="detail"');
    expect(source).toContain("const headingValue");
    expect(source).not.toContain('class="divide-y rounded-xl border"');
    expect(source).not.toContain('class="rounded-xl border p-4"');
    expect(source).not.toContain("divide-y");
    expect(source).toContain('layout={props.block.layout === "summary" ? "rows" : props.block.layout === "context" ? "grid" : props.block.layout}');
    expect(source).toContain("aria-label={messages().downloadFile({ filename: document.filename })}");
    expect(source).toContain("onClick={() => void download(document)}");
    expect(source).toContain("messages().downloadPdf");
    expect(source).toContain('<Placeholder align="left"');
    expect(source).toContain("description={messages().noDocuments}");
    expect(source).not.toContain('<ul class="flex flex-col gap-1">');
    expect(source).toContain("fetch(document.downloadUrl");
    expect(source).toContain("CustomAppDocument");
    expect(source).toContain("{document.filename}");
  });
});
