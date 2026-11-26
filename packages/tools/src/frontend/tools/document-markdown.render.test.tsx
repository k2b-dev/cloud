import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "tools-document-markdown-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ACCEPTED_DOCUMENTS, DocumentMarkdownView, markdownDownloadName, validateDocumentMarkdownFile } = await import(
  "./DocumentMarkdown.island.tsx"
);
const { documentMarkdownMessages } = await import("@/api/document-markdown-messages");
const en = documentMarkdownMessages.resolve(["en"]).t;

const renderView = (props: Parameters<typeof DocumentMarkdownView>[0] = {}) =>
  renderToString(() => createComponent(DocumentMarkdownView, props));

describe("Document to Markdown tool", () => {
  test("offers one way to choose a document, names what it takes, and says where it is sent", () => {
    const html = renderView();

    expect(html.match(/Choose document/g)?.length).toBeGreaterThanOrEqual(2);
    expect(ACCEPTED_DOCUMENTS).toBe(".pdf,.doc,.docx,.odt,.rtf,.ppt,.pptx,.odp,.xlsx,.ods,.csv,.epub");
    expect(html).toContain("PDF, Word, PowerPoint, spreadsheets, RTF, EPUB, or CSV");
    expect(html).toContain("sent to this Cloud server for conversion");
    expect(html).toContain("Neither the upload nor the Markdown result is stored");
    expect(html).toContain("Choose one supported document");
    // one head row: no status row under it
    expect(html).not.toContain('data-k2-part="StatusRow"');
    expect(html).not.toContain('data-k2-part="Loading"');
  });

  test("renders conversion progress with a cancel action", () => {
    const html = renderView({ initialBusy: true, initialFilename: "handbook.pdf" });

    expect(html).toContain("Converting handbook.pdf…");
    expect(html).toContain("Cancel");
    // the document on its way is the last step of the path
    expect(html.slice(html.indexOf('data-k2-part="Path"'))).toContain("handbook.pdf");
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
    expect(html).toContain("&lt;script>alert('unsafe')&lt;/script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("Copy Markdown");
    expect(html).toContain("Download .md");
    expect(html.slice(html.indexOf('data-k2-part="Path"'))).toContain("quarterly-report.docx");
    expect(html).not.toContain('data-k2-part="StatusRow"');
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
