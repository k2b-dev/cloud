import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "tools-markdown-pdf-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { MarkdownPdfView, MINIMAL_CUSTOM_CSS, markdownPdfFilename, validateMarkdownPdfInput } = await import("./MarkdownPdf.island.tsx");
const { markdownPdfMessages } = await import("@/api/markdown-pdf-messages");
const en = markdownPdfMessages.resolve(["en"]).t;
const renderView = (props: Parameters<typeof MarkdownPdfView>[0] = {}) => renderToString(() => createComponent(MarkdownPdfView, props));

describe("Markdown to PDF tool", () => {
  test("renders accessible Markdown, template, filename, and generation controls", () => {
    const html = renderView();

    expect(html).toContain("Markdown");
    expect(html).toContain("Template");
    expect(html).toContain("Filename");
    expect(html).toContain("Custom");
    expect(html).not.toContain("This replaces the print template");
    expect(html).toContain("Generate PDF");
    expect(html).toContain("No PDF generated yet");
    expect(html).toContain("processed in memory and are not stored");
    expect(html).toContain('class="ti ti-file-type-pdf');
    expect(html).toContain("h-[28rem] min-h-0 shrink-0 lg:h-auto lg:flex-1 lg:shrink");
    expect(html.indexOf("processed in memory and are not stored")).toBeLessThan(html.indexOf("Generate PDF"));
  });

  test("shows prefilled CSS directly below Markdown for the Custom template", () => {
    const html = renderView({ initialTemplateId: "custom" });

    expect(html).toContain("Custom CSS");
    expect(html).toContain("This replaces the print template");
    expect(MINIMAL_CUSTOM_CSS).toContain("@page { size: A4; margin: 20mm; }");
    expect(html.indexOf("Custom CSS")).toBeLessThan(html.indexOf("processed in memory and are not stored"));
  });

  test("renders loading, error, and completed preview states", () => {
    const loading = renderView({ initialBusy: true, initialMarkdown: "# Cloud" });
    const error = renderView({ initialError: "PDF rendering is not configured." });
    const ready = renderView({ initialMarkdown: "# Cloud", initialPreviewUrl: "https://example.test/preview.pdf" });

    expect(loading).toContain("Generating PDF…");
    expect(loading).toContain("Cancel");
    expect(error).toContain("PDF generation failed");
    expect(error).toContain('role="alert"');
    expect(ready).toContain('title="Generated PDF preview"');
    expect(ready).toContain('src="https://example.test/preview.pdf"');
    expect(ready).toContain("Open");
    expect(ready).toContain("Download PDF");
    expect(ready).toContain('role="status">PDF generation complete.');
  });

  test("normalizes PDF filenames and validates UTF-8 byte budgets", () => {
    expect(markdownPdfFilename("report")).toBe("report.pdf");
    expect(markdownPdfFilename("../quarterly.pdf")).toBe("quarterly.pdf");
    expect(markdownPdfFilename("bad/name")).toBe("name.pdf");
    expect(markdownPdfFilename(".pdf")).toBe("document.pdf");
    expect(markdownPdfFilename("x".repeat(255))).toHaveLength(255);
    expect(validateMarkdownPdfInput("", "document", "", "document.pdf", en)).toBe("Enter Markdown before generating a PDF.");
    expect(validateMarkdownPdfInput("Cloud", "custom", "", "document.pdf", en)).toBe("Enter CSS for the Custom template.");
    expect(validateMarkdownPdfInput("Cloud", "custom", MINIMAL_CUSTOM_CSS, "", en)).toBe("Enter a PDF filename.");
    expect(validateMarkdownPdfInput("🫶".repeat(Math.floor((256 * 1024) / 4) + 1), "document", "", "document.pdf", en)).toBe(
      "Markdown exceeds the 256 KiB limit.",
    );
  });
});
