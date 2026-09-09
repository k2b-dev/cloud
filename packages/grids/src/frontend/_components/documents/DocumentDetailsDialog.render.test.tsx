import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";
import type { PublicDocument } from "./public-document-types";

const { DocumentDetailsDialog } = await import("./DocumentDetailsDialog");

const document: PublicDocument = {
  id: "DOC001",
  baseId: "BASE01",
  tableId: "TABLE1",
  recordId: "RECORD",
  templateId: "TMPL01",
  number: "INV-2026-1",
  filename: "invoice.pdf",
  createdAt: "2026-09-09T12:00:00Z",
  createdBy: "creator-uuid",
  tags: [],
  renderer: { kind: "html" },
  validationStatus: "warning",
  artifacts: [
    { key: "pdf", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1024, sha256: "a".repeat(64) },
    { key: "structured", filename: "invoice.xml", mimeType: "application/xml", sizeBytes: 512, sha256: "b".repeat(64) },
  ],
};

test("document summary keeps files and warnings visible but defers technical data and links", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: { document, templateName: "Invoice", canWrite: true, onDownload: () => {}, onGenerateAgain: () => {} },
      close: () => {},
    }),
  );
  expect(html).toContain("invoice.xml");
  expect(html).toContain("Warning");
  expect(html).toContain("Technical details");
  expect(html).toContain("Share links");
  expect(html).toContain("IDs &amp; checksums");
  expect(html).toContain("grids-document-detail-row");
  expect(html).not.toContain("No active links");
  expect(html).toContain("More actions");
  expect(html).not.toContain("SHA-256");
  expect(html).not.toContain("creator-uuid");
  expect(html).not.toContain("No public links");
  expect(html).not.toContain("border-subtle");
  expect(html.match(/Download PDF/g)).toHaveLength(1);
});

test("read-only document summary has no link management or generation action", () => {
  const html = renderToString(() =>
    createComponent(DocumentDetailsDialog, {
      args: { document, canWrite: false, onDownload: () => {}, onGenerateAgain: () => {} },
      close: () => {},
    }),
  );
  expect(html).not.toContain("Share links");
  expect(html).not.toContain("More actions");
  expect(html).toContain("Download PDF");
});
