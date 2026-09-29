import { beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GotenbergConfig, renderHtmlToPdfWithConfig } from "@k2b/cloud/services/pdf";
import { pdfTitle } from "../../../../scripts/fixtures/pdf-info";
import { requireInfraUrl, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { buildNotePdfHtml } from "./note-pdf";

const NOTICES = ["note", "info", "success", "warning", "danger"] as const;

/** Poppler's text layer of a PDF. A missing pdftotext fails instead of passing vacuously. */
const pdfText = async (pdf: Uint8Array): Promise<string> => {
  const pdftotext = Bun.which(process.env.PDFTOTEXT ?? "pdftotext");
  if (!pdftotext) throw new Error("Poppler's pdftotext is not on PATH; install Poppler or set PDFTOTEXT.");
  const directory = await mkdtemp(join(tmpdir(), "notebooks-note-pdf-"));
  try {
    const path = join(directory, "note.pdf");
    await Bun.write(path, pdf);
    const run = Bun.spawn([pdftotext, "-enc", "UTF-8", path, "-"], { stdout: "pipe", stderr: "pipe" });
    const [text, error, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    if (code !== 0) throw new Error(`pdftotext failed: ${error}`);
    return text;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      expect(await pdfTitle(pdf)).toBe("Hiking weekend");
    }
  }, 120_000);
});
