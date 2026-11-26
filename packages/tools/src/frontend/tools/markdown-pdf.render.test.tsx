import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "tools-markdown-pdf-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { MarkdownPdfView, MINIMAL_CUSTOM_CSS, markdownPdfFilename, validateMarkdownPdfInput } = await import("./MarkdownPdf.island.tsx");
const { markdownPdfMessages } = await import("@/api/markdown-pdf-messages");
const en = markdownPdfMessages.resolve(["en"]).t;
const renderView = (props: Parameters<typeof MarkdownPdfView>[0] = {}) => renderToString(() => createComponent(MarkdownPdfView, props));

describe("Markdown to PDF tool", () => {
  test("renders the Markdown editor, template, filename and the one way to generate", () => {
    const html = renderView();

    expect(html).toContain('aria-label="Markdown"');
    expect(html).toContain("Template");
    expect(html).toContain("Filename");
    expect(html).toContain("Neutral typography");
    expect(html).not.toContain("This replaces the print template");
    expect(html.match(/Generate PDF/g)?.length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("processed in memory and are not stored");
    // no half of the page waits empty for a PDF: the preview comes with the first one
    expect(html).not.toContain('aria-label="PDF preview"');
    expect(html).not.toContain("No PDF generated yet");
  });

  test("shows prefilled CSS below the Markdown for the Custom template", () => {
    const html = renderView({ initialTemplateId: "custom" });

    expect(html).toContain("Custom CSS");
    expect(html).toContain("This replaces the print template");
    expect(MINIMAL_CUSTOM_CSS).toContain("@page { size: A4; margin: 20mm; }");
    expect(html.indexOf('aria-label="Markdown"')).toBeLessThan(html.indexOf("Custom CSS"));
  });

  test("renders loading, error, and completed preview states", () => {
    const loading = renderView({ initialBusy: true, initialMarkdown: "# Cloud" });
    const error = renderView({ initialError: "PDF rendering is not configured." });
    const ready = renderView({ initialMarkdown: "# Cloud", initialPreviewUrl: "https://example.test/preview.pdf" });

    expect(loading).toContain("Generating PDF…");
    expect(loading).toContain('aria-label="PDF preview"');
    expect(loading).toContain("Cancel");
    expect(error).toContain("PDF generation failed");
    expect(error).toContain("PDF rendering is not configured.");
    expect(ready).toContain('title="Generated PDF preview"');
    expect(ready).toContain('src="https://example.test/preview.pdf"');
    expect(ready).toContain("Open");
    expect(ready).toContain("Download PDF");
    expect(ready).toContain("PDF generation complete.");
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
