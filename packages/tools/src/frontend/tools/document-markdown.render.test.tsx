import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "tools-document-markdown-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { DocumentMarkdownView, markdownDownloadName, validateDocumentMarkdownFile } = await import("./DocumentMarkdown.island.tsx");
const { documentMarkdownMessages } = await import("@/api/document-markdown-messages");
const en = documentMarkdownMessages.resolve(["en"]).t;

const renderView = (props: Parameters<typeof DocumentMarkdownView>[0] = {}) =>
  renderToString(() => createComponent(DocumentMarkdownView, props));

describe("Document to Markdown tool", () => {
  test("renders one accessible drop target and explicit server privacy copy", () => {
    const html = renderView();

    expect(html).toContain('aria-label="Choose a document to convert to Markdown"');
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.odp,.xlsx,.ods,.csv,.epub"');
    expect(html).toContain('class="ti ti-markdown"');
    expect(html).not.toContain(".xls,");
    expect(html).toContain("sent to this Cloud server for conversion");
    expect(html).toContain("Neither the upload nor the Markdown result is stored");
    expect(html).toContain("Markdown preview");
  });

  test("renders conversion progress with a cancel action", () => {
    const html = renderView({ initialBusy: true, initialFilename: "handbook.pdf" });

    expect(html).toContain("Converting document…");
    expect(html).toContain("Converting handbook.pdf…");
    expect(html).toContain('role="status"');
    expect(html).toContain("Cancel");
    expect(html).toMatch(/aria-label="Choose a document to convert to Markdown"[^>]* disabled/);
  });

  test("keeps extracted Markdown plain and exposes copy and download actions", () => {
    const html = renderView({
      initialResult: {
        filename: "quarterly-report.docx",
        format: "docx",
        markdown: "# Report\n\n<script>alert('unsafe')</script>",
        inputBytes: 2048,
        outputBytes: 48,
        truncated: false,
      },
    });

    expect(html).toContain("quarterly-report.docx");
    expect(html).toContain("DOCX · 2 KB input · 48 B Markdown");
    expect(html).toContain('aria-label="Plain Markdown extracted from quarterly-report.docx"');
    expect(html).toContain(`value="# Report\n\n<script>alert('unsafe')</script>"`);
    expect(html).not.toContain("</textarea><script>");
    expect(html).toContain("Copy Markdown");
    expect(html).toContain("Download .md");
    expect(html).toContain('role="status">Conversion complete for quarterly-report.docx.');
  });

  test("shows typed errors and output truncation without hiding either state", () => {
    const error = renderView({ initialError: "The PDF has no readable text and requires OCR." });
    const truncated = renderView({
      initialResult: {
        filename: "large.pdf",
        format: "pdf",
        markdown: "shortened",
        inputBytes: 4096,
        outputBytes: 1024 * 1024,
        truncated: true,
      },
    });

    expect(error).toContain("Conversion failed");
    expect(error).toContain("requires OCR");
    expect(error).toContain('role="alert"');
    expect(truncated).toContain("Preview shortened");
    expect(truncated).toContain("1 MB output limit");
  });

  test("derives safe Markdown download names", () => {
    expect(markdownDownloadName("report.final.pdf")).toBe("report.final.md");
    expect(markdownDownloadName("../notes.docx")).toBe("notes.md");
    expect(markdownDownloadName(".pdf")).toBe("document.md");
  });

  test("rejects oversized files and long filenames before upload", () => {
    expect(validateDocumentMarkdownFile({ name: "report.pdf", size: 20 * 1024 * 1024 }, en)).toBeNull();
    expect(validateDocumentMarkdownFile({ name: "report.pdf", size: 20 * 1024 * 1024 + 1 }, en)).toBe(
      "The document exceeds the 20 MB limit.",
    );
    expect(validateDocumentMarkdownFile({ name: `${"a".repeat(252)}.pdf`, size: 1 }, en)).toBe(
      "The filename must not exceed 255 characters.",
    );
  });
});
