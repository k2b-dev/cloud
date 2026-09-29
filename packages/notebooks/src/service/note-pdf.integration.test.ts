import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { type GotenbergConfig, renderHtmlToPdfWithConfig } from "@k2b/cloud/services/pdf";
import { pdfTitle } from "../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { buildNotePdfHtml } from "./note-pdf";

const NOTICES = ["note", "info", "success", "warning", "danger"] as const;

/** Output of a Poppler tool for a PDF. A missing tool fails instead of passing vacuously. */
const poppler = async (tool: "pdftotext" | "pdffonts", pdf: Uint8Array, args: string[]): Promise<string> => {
  const binary = Bun.which(process.env[tool.toUpperCase()] ?? tool);
  if (!binary) throw new Error(`Poppler's ${tool} is not on PATH; install Poppler or set ${tool.toUpperCase()}.`);
  const directory = await mkdtemp(join(tmpdir(), "notebooks-note-pdf-"));
  try {
    const path = join(directory, "note.pdf");
    await Bun.write(path, pdf);
    const run = Bun.spawn([binary, ...args, path, ...(tool === "pdftotext" ? ["-"] : [])], { stdout: "pipe", stderr: "pipe" });
    const [output, error, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(`${tool} failed: ${error}`);
    return output;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** Poppler's text layer of a PDF: what copy and search see. */
const pdfText = (pdf: Uint8Array) => poppler("pdftotext", pdf, ["-enc", "UTF-8"]);

/** Fonts that draw the PDF, without subset prefixes, and whether each is embedded, subset, and mapped to Unicode. */
const pdfFonts = async (pdf: Uint8Array) =>
  (await poppler("pdffonts", pdf, []))
    .split("\n")
    .slice(2)
    .filter((line) => line.trim())
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const [emb, sub, uni] = fields.slice(-5, -2);
      return { name: fields[0]!.replace(/^[A-Z]{6}\+/, ""), embedded: emb === "yes", subset: sub === "yes", unicode: uni === "yes" };
    });

/**
 * Letters that Chromium drew as one ligature glyph, such as `ffi`. It marks
 * each ligature glyph with its letters as `ActualText`, which copy and search use.
 */
const pdfLigatures = (pdf: Uint8Array): string[] => {
  const raw = Buffer.from(pdf).toString("latin1");
  return [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].flatMap(([, data = ""]) => {
    let content = data;
    try {
      content = inflateSync(Buffer.from(data, "latin1")).toString("latin1");
    } catch {
      // Not Flate-compressed: search the stream as stored.
    }
    return [...content.matchAll(/\/ActualText \(([^)]*)\)/g)].map(([, letters = ""]) => letters);
  });
};

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

  test("ligatures print like the reader and copy as text", async () => {
    const words = "office, affine, fluffy, finally, ffi, ffl";
    const markdown = [
      "# Office flow -> finally != done",
      `Body: ${words}. Arrows -> <- <-> => <=> and x != y, a <= b, c >= d (c) 2026 ...`,
      "```ts\nconst office = (fluffy) => fluffy !== affine; // -> => != ffi\n```",
    ].join("\n\n");
    // In Gotenberg, Noto Sans forms f-ligatures: the document preset throughout and the report's
    // headings. The report's body font, Liberation Serif, has none.
    for (const { templateId, ligatures } of [
      { templateId: "document", ligatures: ["ffi", "ffl", "fi", "fl"] },
      { templateId: "report", ligatures: ["ffi", "fi", "fl"] },
    ] as const) {
      const html = buildNotePdfHtml({ markdown, notebookShortId: "ABC123", locale: "en", templateId });
      const pdf = (await renderHtmlToPdfWithConfig({ html, title: "Ligatures" }, config)).pdf;
      // The ligature glyphs are really there, so the plain-letter checks below cover them.
      expect(pdfLigatures(pdf)).toEqual(expect.arrayContaining([...ligatures]));
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
