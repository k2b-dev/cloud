import { beforeAll, expect, test } from "bun:test";
import { type GotenbergConfig, renderHtmlToPdfWithConfig } from "@k2b/cloud/services/pdf";
import { pdfFonts, pdfLigatures, pdfText, pdfTitle } from "../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { buildNotePdfHtml } from "./note-pdf";

const NOTICES = ["note", "info", "success", "warning", "danger"] as const;

suiteFor("gotenberg")("note PDF export in Gotenberg", () => {
  let config: GotenbergConfig;

  beforeAll(() => {
    config = { url: requireInfraUrl("gotenberg"), timeoutMs: 30_000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
  });

  test("every notice kind prints its content without the directive source", async () => {
    const markdown = [
      "# Hiking weekend",
      ...NOTICES.map((kind) => `:::${kind}\nPack the ${kind} checklist.\n:::`),
      "@gear\n:::data\ntent: Two-person\n:::",
      "Pack weight $w = 12$ kg.",
      "```mermaid\ngraph TD; Tent-->Stakes\n```",
    ].join("\n\n");
    for (const templateId of ["document", "report", "compact", undefined] as const) {
      const html = buildNotePdfHtml({
        markdown,
        notebookShortId: "ABC123",
        locale: "en",
        templateId,
        customCss: templateId ? undefined : "body { font: 10pt sans-serif; }",
      });
      const pdf = (await renderHtmlToPdfWithConfig({ html, title: "Hiking weekend" }, config)).pdf;
      const text = await pdfText(pdf);
      expect(text).not.toContain(":::");
      expect(text).toContain("Hiking weekend");
      for (const kind of NOTICES) expect(text).toContain(`Pack the ${kind} checklist.`);
      expect(text).toContain("Two-person");
      expect(text).toMatch(/Pack weight\s*w\s*=\s*12\s*kg\./u);
      expect(text).toContain("Diagram source");
      expect(text).toContain("graph TD; Tent-->Stakes");
      expect(await pdfTitle(pdf)).toBe("Hiking weekend");
    }
  }, 120_000);

  test("a link to the exported note jumps within the PDF, to its heading or to its top", async () => {
    const markdown =
      "# Guide\n\n[Restore steps](note://DEF456#restore) [Missing](note://DEF456#nope) [Top](note://DEF456)\n\n## Restore\n\nDone.";
    const html = buildNotePdfHtml({ markdown, notebookShortId: "ABC123", noteShortId: "DEF456", locale: "en" });
    const raw = Buffer.from((await renderHtmlToPdfWithConfig({ html, title: "Guide" }, config)).pdf).toString("latin1");
    // Chromium writes link annotations uncompressed; a named destination is a link inside the document.
    const links = raw.match(/\/Subtype \/Link\b[^>]*>/g) ?? [];
    expect(links.map((link) => /\/Dest \/([^\s>]+)/.exec(link)?.[1])).toEqual(["heading-restore", "top", "top"]);
    // Chromium places `#top` at the top edge of the note's only page.
    expect(raw).toMatch(/\/top \[\d+ 0 R \/XYZ 0 [\d.]+ 0\]/);
  }, 60_000);

  test("references print as labelled pills and web links with a printed arrow", async () => {
    const markdown = [
      "# Brand",
      "See [Akzentfarbe](note://DEF456#akzentfarbe) and [Affinity Designer](https://affinity.serif.com).",
      "",
      "[Markenrichtlinien-2026.pdf](attach://PDF001)",
    ].join("\n");
    const references = {
      notes: new Map([["DEF456", "Farbsystem"]]),
      attachments: new Map([["PDF001", { filename: "Markenrichtlinien-2026.pdf", sizeBytes: 4_200_000 }]]),
    };
    for (const templateId of ["document", "report", "compact"] as const) {
      const html = buildNotePdfHtml({ markdown, notebookShortId: "ABC123", locale: "de", templateId, references });
      const text = await pdfText((await renderHtmlToPdfWithConfig({ html, title: "Brand" }, config)).pdf);
      expect(text).toContain("Farbsystem › Akzentfarbe");
      expect(text).toMatch(/Affinity Designer ?↗/u);
      expect(text).toMatch(/Markenrichtlinien-2026\.pdf\s*4,2 MB/u);
    }
  }, 120_000);

  test("ligatures print like the reader and copy as text", async () => {
    const words = "office, affine, fluffy, finally, ffi, ffl";
    const markdown = [
      "# Office flow -> finally != done",
      `Body: ${words}. Arrows -> <- <-> => <=> and x != y, a <= b, c >= d (c) 2026 ...`,
      "```ts\nconst office = (fluffy) => fluffy !== affine; // -> => != ffi\n```",
    ].join("\n\n");
    // In Gotenberg, Noto Sans (document) and Noto Serif (report body) form f-ligatures.
    for (const templateId of ["document", "report"] as const) {
      const html = buildNotePdfHtml({ markdown, notebookShortId: "ABC123", locale: "en", templateId });
      const pdf = (await renderHtmlToPdfWithConfig({ html, title: "Ligatures" }, config)).pdf;
      // The ligature glyphs are really there, so the plain-letter checks below cover them.
      expect(pdfLigatures(pdf)).toEqual(expect.arrayContaining(["ffi", "ffl", "fi", "fl"]));
      const text = await pdfText(pdf);
      expect(text).toContain("Office flow → finally ≠ done");
      expect(text).toContain(`Body: ${words}.`);
      expect(text).toMatch(/Arrows → ← ↔ ⇒ ⇔ and x ≠ y, a ≤ b, c ≥ d © 2026 …/u);
      expect(text).not.toMatch(/[\ufb00-\ufb06\ufffd]/u);
      // Code keeps the typed characters, as in the reader.
      expect(text).toContain("const office = (fluffy) => fluffy !== affine; // -> => != ffi");

      const fonts = await pdfFonts(pdf);
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) expect(font).toMatchObject({ embedded: true, subset: true, unicode: true });
      const names = fonts.map((font) => font.name);
      // Arrows and relations come from DejaVu Sans in body text and headings.
      expect(names).toEqual(expect.arrayContaining(["DejaVuSans", "DejaVuSans-Bold"]));
      // Without the symbol font, Chromium drew arrows with Liberation Sans and composed `≠` from `=` and a slash.
      expect(names.filter((name) => name.startsWith("LiberationSans"))).toEqual([]);
    }
  }, 120_000);
});
