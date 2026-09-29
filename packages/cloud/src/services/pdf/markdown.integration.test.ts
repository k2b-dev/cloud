import { beforeAll, expect, test } from "bun:test";
import { pdfFonts, pdfLigatures, pdfText } from "../../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../../scripts/fixtures/test-infra";
import type { GotenbergConfig } from "./gotenberg";
import { renderMarkdownToPdfWithConfig } from "./markdown";

suiteFor("gotenberg")("Markdown PDF presets in Gotenberg", () => {
  let config: GotenbergConfig;

  beforeAll(() => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30_000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
  });

  test("the report body forms f-ligatures that copy as plain letters", async () => {
    // The heading has no f-ligature words, so every ligature comes from the serif body.
    const body = "The office staff finally reshuffled the affine flow charts.";
    const emphasis = "Bold affluence and italic fluffy fields.";
    const pdf = (
      await renderMarkdownToPdfWithConfig(
        { markdown: `# Quarterly summary\n\n${body}\n\n**Bold affluence** and *italic fluffy fields*.`, templateId: "report" },
        config,
      )
    ).pdf;

    expect(pdfLigatures(pdf)).toEqual(expect.arrayContaining(["ffi", "ffl", "fi", "fl"]));
    const text = await pdfText(pdf);
    expect(text).toContain(body);
    expect(text).toContain(emphasis);
    expect(text).not.toMatch(/[ﬀ-ﬆ�]/u);

    const fonts = await pdfFonts(pdf);
    for (const font of fonts) expect(font).toMatchObject({ embedded: true, subset: true, unicode: true });
    const names = fonts.map((font) => font.name);
    expect(names).toEqual(expect.arrayContaining(["NotoSerif-Regular", "NotoSerif-Bold", "NotoSerif-Italic"]));
    // Liberation Serif, the Times New Roman substitute, has no f-ligatures.
    expect(names.filter((name) => name.startsWith("LiberationSerif"))).toEqual([]);
  }, 60_000);
});
